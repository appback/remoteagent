import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dotWebhookHeaders, type DotWebhookPost } from "./dot-webhook.js";

const EVENT = "telegram.message.created";
const CAPACITY = 500;
type Channel = { id: string; botId: string; chatId: string; owner: string; enabled?: boolean };
type Subscription = { id: string; owner: string; channelId: string; url: string; secret: string; expires: number; authorization?: string;
  previousSecret?: string; previousSecretExpires?: number };
type Report = { id: string; fingerprint: string; kind: "progress" | "result"; status: "sending" | "sent" | "unknown" };
type Message = { id: string; channelId: string; updateId: string; text: string; createdAt: string;
  subscriptionId: string; status: "pending" | "sending" | "accepted" | "failed" | "canceled" | "completed";
  attempts: number; nextAttempt: number; reports: Report[]; issue?: string };
type State = { version: 1; channels: Channel[]; subscriptions: Subscription[]; messages: Message[] };
type Reporter = (chatId: string, text: string) => Promise<void>;

export class DotBridgeService {
  private state: State;
  private readonly file: string;
  private reporters = new Map<string, Reporter>();
  private tail: Promise<unknown> = Promise.resolve();
  private pumping = false;
  private storageFailed = false;
  private timer?: NodeJS.Timeout;
  private paused = false;
  private loginCodeIssuer?: () => { code: string; expiresAt: string };

  constructor(dataDir: string, readonly owner: string, private readonly post: DotWebhookPost,
    private readonly now: () => number = Date.now,
    private readonly authorizeDelivery?: (authorization: string | undefined) => Promise<string | undefined>) {
    const dir = path.join(dataDir, "dot");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.file = path.join(dir, "bridge.json");
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) as State
      : { version: 1, channels: [], subscriptions: [], messages: [] };
    if (this.state.version !== 1) throw Error("UNSUPPORTED_DOT_STATE");
    for (const message of this.state.messages) {
      if (message.status === "sending") message.status = "pending"; // Same webhook event ID on replay.
      for (const report of message.reports) if (report.status === "sending") report.status = "unknown";
    }
    this.save();
  }

  register(botId: string, reporter: Reporter): void { this.reporters.set(botId, reporter); }
  setLoginCodeIssuer(issuer: () => { code: string; expiresAt: string }): void { this.loginCodeIssuer = issuer; }
  issueLoginCode() { return this.loginCodeIssuer?.(); }
  pause(): void { this.paused = true; this.close(); }
  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => { void this.pump().catch(() => console.error("Dot delivery worker failed; inspect /dot status.")); }, 30000);
      this.timer.unref();
    }
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  isBound(botId: string, chatId: string): boolean {
    const channel = this.channelForChat(botId, chatId);
    return Boolean(channel && channel.enabled !== false);
  }
  channels(owner: string) { return this.state.channels.filter(c => c.owner === owner).map(c => ({ channelId: c.id })); }

  connection(botId: string, chatId: string) {
    const channel = this.channelForChat(botId, chatId);
    return { channelId: channel?.id, subscribed: Boolean(channel && this.activeSubscription(channel.id)),
      enabled: this.isBound(botId, chatId), available: !this.paused && !this.storageFailed };
  }

  async prepare(botId: string, chatId: string): Promise<string> {
    return this.exclusive(() => {
      if (this.paused) throw Error("DOT_CONFIGURATION_UNAVAILABLE");
      const old = this.channelForChat(botId, chatId);
      if (old) return old.id;
      if (this.state.channels.length >= 100) throw Error("DOT_CHANNEL_LIMIT");
      const channel = { id: randomUUID(), botId, chatId, owner: this.owner, enabled: false };
      this.state.channels.push(channel); this.save(); return channel.id;
    });
  }

  async activate(botId: string, chatId: string): Promise<string> {
    return this.exclusive(() => {
      if (this.paused) throw Error("DOT_CONFIGURATION_UNAVAILABLE");
      const channel = this.channelForChat(botId, chatId);
      if (!channel || !this.activeSubscription(channel.id)) throw Error("DOT_NOT_SUBSCRIBED");
      channel.enabled = true; this.save(); return channel.id;
    });
  }

  async suspend(botId: string, chatId: string): Promise<void> {
    await this.exclusive(() => {
      const channel = this.channelForChat(botId, chatId);
      if (!channel) return;
      channel.enabled = false;
      for (const message of this.state.messages) {
        if (message.channelId === channel.id && !["completed", "canceled"].includes(message.status)) message.status = "canceled";
      }
      this.save();
    });
  }

  async connect(botId: string, chatId: string): Promise<string> {
    return this.exclusive(() => {
      if (this.paused) throw Error("DOT_CONFIGURATION_UNAVAILABLE");
      const old = this.channelForChat(botId, chatId);
      if (old) { old.enabled = true; this.save(); return old.id; }
      if (this.state.channels.length >= 100) throw Error("DOT_CHANNEL_LIMIT");
      const channel = { id: randomUUID(), botId, chatId, owner: this.owner };
      this.state.channels.push(channel); this.save(); return channel.id;
    });
  }

  async disconnect(botId: string, chatId: string): Promise<void> {
    await this.exclusive(() => {
      const channel = this.channelForChat(botId, chatId);
      if (!channel) return;
      this.state.channels = this.state.channels.filter(c => c.id !== channel.id);
      this.state.subscriptions = this.state.subscriptions.filter(s => s.channelId !== channel.id);
      for (const message of this.state.messages) if (message.channelId === channel.id) message.status = "canceled";
      this.save();
    });
  }

  status(botId: string, chatId: string): string {
    if (this.storageFailed) return "Dot bridge paused: state storage failed. Restore disk access and restart RemoteAgent before resending.";
    if (this.paused) return "Dot bridge paused: OAuth/MCP configuration is unavailable or disabled. Restore configuration and restart, or /dot off to use the previous local session.";
    const channel = this.channelForChat(botId, chatId);
    if (!channel) return "Dot routing: off. Existing Codex/Claude routing is unchanged.\n/dot connect";
    const subscription = this.activeSubscription(channel.id);
    const messages = this.state.messages.filter(m => m.channelId === channel.id);
    const last = messages.at(-1);
    return [`Dot channel: ${channel.id}`, `Subscription: ${subscription ? "verified" : "not connected or expired"}`,
      `Routing: ${channel.enabled === false ? "not started; /start dot" : "active"}`,
      `Awaiting result: ${messages.filter(m => ["pending", "sending", "accepted"].includes(m.status)).length}`,
      last ? `Latest request: ${last.id}; ${last.status}${last.issue ? `; ${last.issue}` : ""}` : "No requests yet.",
      "Text only. /dot off restores local provider routing."].join("\n");
  }

  async cancel(botId: string, chatId: string): Promise<number> {
    return this.exclusive(() => {
      const channel = this.channelForChat(botId, chatId);
      let count = 0;
      for (const message of this.state.messages) {
        if (message.channelId === channel?.id && !["completed", "canceled"].includes(message.status)) {
          message.status = "canceled"; count++;
        }
      }
      this.save(); return count;
    });
  }

  async enqueue(botId: string, chatId: string, updateId: string, text: string): Promise<string> {
    const id = await this.exclusive(() => {
      if (this.paused) throw Error("DOT_CONFIGURATION_UNAVAILABLE: restore configuration or /dot off; request not forwarded to a local provider.");
      const channel = this.channelForChat(botId, chatId);
      if (!channel) throw Error("DOT_NOT_BOUND");
      if (channel.enabled === false) throw Error("DOT_NOT_STARTED: use /start dot after connecting.");
      const old = this.state.messages.find(m => m.channelId === channel.id && m.updateId === updateId);
      if (old) return old.id;
      const subscription = this.activeSubscription(channel.id);
      if (!subscription) throw Error("DOT_NOT_SUBSCRIBED: connect this channel from your dot first; message not queued.");
      if (!text.trim() || Buffer.byteLength(text) > 128 * 1024) throw Error("DOT_TEXT_LIMIT: maximum 128 KiB.");
      this.prune();
      if (this.state.messages.length >= CAPACITY) throw Error("DOT_QUEUE_FULL");
      const message: Message = { id: randomUUID(), channelId: channel.id, updateId, text,
        createdAt: new Date(this.now()).toISOString(), subscriptionId: subscription.id,
        status: "pending", attempts: 0, nextAttempt: 0, reports: [] };
      this.state.messages.push(message); this.save(); return message.id;
    });
    void this.pump().catch(() => console.error("Dot delivery failed; request retained in /dot status."));
    return id;
  }

  async subscribe(owner: string, params: Record<string, unknown>, authorization?: string) {
    return this.exclusive(async () => {
      if (this.paused) throw Error("DOT_CONFIGURATION_UNAVAILABLE");
      const { channel, delivery } = this.subscriptionInput(owner, params);
      if (typeof delivery.secret !== "string") throw Error("INVALID_SIGNING_SECRET");
      dotWebhookHeaders(delivery.secret, "verification", "verification", "{}");
      const identity = JSON.stringify([owner, channel.id, EVENT, delivery.url]);
      const id = createHash("sha256").update(identity).digest("hex");
      const existing = this.activeSubscription(channel.id);
      if (existing && existing.id !== id) throw Error("DOT_CHANNEL_ALREADY_SUBSCRIBED: unsubscribe the previous dot first.");
      // Refresh only after the previous subscription expires would lose events: cap TTL and preserve identity.
      const requested = params.ttlMs === undefined || params.ttlMs === null ? 86400000 : params.ttlMs;
      if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) throw Error("INVALID_TTL");
      const expires = this.now() + Math.min(requested, 86400000);
      if (!existing || existing.secret !== delivery.secret) {
        const challenge = randomUUID();
        let response;
        try {
          response = await this.post(delivery.url as string, delivery.secret, id, randomUUID(),
            JSON.stringify({ type: "verification", challenge }));
        } catch (error) {
          if (error instanceof Error && /^CALLBACK_[A-Z_]+(?:: [a-zA-Z0-9.:[\]-]+)?$/.test(error.message)) throw error;
          throw Error("CALLBACK_VERIFICATION_FAILED: network_error");
        }
        let echoed = "";
        try { echoed = JSON.parse(response.body).challenge ?? ""; } catch { /* Invalid response fails closed. */ }
        const a = Buffer.from(challenge), b = Buffer.from(typeof echoed === "string" ? echoed : "");
        if (response.status < 200 || response.status >= 300 || a.length !== b.length || !timingSafeEqual(a, b)) {
          throw Error("CALLBACK_VERIFICATION_FAILED");
        }
      }
      this.state.subscriptions = this.state.subscriptions.filter(s => s.channelId !== channel.id);
      this.state.subscriptions.push({ id, owner, channelId: channel.id, url: delivery.url as string,
        secret: delivery.secret, expires, authorization,
        previousSecret: existing && existing.secret !== delivery.secret ? existing.secret : existing?.previousSecret,
        previousSecretExpires: existing && existing.secret !== delivery.secret ? this.now() + 300000 : existing?.previousSecretExpires });
      this.save(); return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    });
  }

  async unsubscribe(owner: string, params: Record<string, unknown>): Promise<Record<string, never>> {
    return this.exclusive(() => {
      const { channel, delivery } = this.subscriptionInput(owner, params);
      const removed = this.state.subscriptions.filter(s => s.owner === owner && s.channelId === channel.id && s.url === delivery.url);
      this.state.subscriptions = this.state.subscriptions.filter(s => !removed.includes(s));
      for (const message of this.state.messages) if (removed.some(s => s.id === message.subscriptionId)
        && !["completed", "canceled"].includes(message.status)) message.status = "canceled";
      this.save(); return {};
    });
  }

  read(owner: string, requestId: string) {
    const message = this.authorizeMessage(owner, requestId);
    return { requestId: message.id, channelId: message.channelId, text: message.text,
      createdAt: message.createdAt, status: message.status };
  }

  async report(owner: string, args: Record<string, unknown>) {
    return this.exclusive(async () => {
      if (this.paused) throw Error("DOT_CONFIGURATION_UNAVAILABLE");
      if (Object.keys(args).some(key => !["requestId", "reportId", "kind", "text"].includes(key))) throw Error("INVALID_REPORT");
      const message = this.authorizeMessage(owner, String(args.requestId ?? ""));
      if (typeof args.reportId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(args.reportId)
        || !["progress", "result"].includes(String(args.kind)) || typeof args.text !== "string"
        || !args.text.trim() || args.text.length > 3000) throw Error("INVALID_REPORT: text limit is 3000 characters.");
      const fingerprint = createHash("sha256").update(JSON.stringify([args.kind, args.text])).digest("hex");
      const old = message.reports.find(r => r.id === args.reportId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw Error("REPORT_ID_CONFLICT");
        return { status: old.status, requestId: message.id };
      }
      if (["canceled", "completed"].includes(message.status)) throw Error("DOT_REQUEST_CLOSED");
      if (message.reports.some(r => r.status === "unknown")) throw Error("DOT_DELIVERY_UNKNOWN: check Telegram before sending another report.");
      if (message.reports.length >= 20) throw Error("DOT_REPORT_LIMIT");
      const channel = this.state.channels.find(c => c.id === message.channelId)!;
      const reporter = this.reporters.get(channel.botId);
      if (!reporter) throw Error("DOT_TELEGRAM_UNAVAILABLE");
      const report: Report = { id: args.reportId, fingerprint, kind: args.kind as Report["kind"], status: "sending" };
      message.reports.push(report); this.save();
      try {
        await reporter(channel.chatId, `[DOT | ${args.kind}]\n${args.text}`);
        report.status = "sent";
        if (args.kind === "result") message.status = "completed";
        this.save(); return { status: "sent", requestId: message.id };
      } catch {
        report.status = "unknown"; this.save();
        throw Error("DOT_DELIVERY_UNKNOWN: automatic resend is disabled; check Telegram.");
      }
    });
  }

  async pump(): Promise<void> {
    if (this.pumping || this.paused) return;
    this.pumping = true;
    try {
      // At most four deliveries per pass; no per-message timers or unbounded parallelism.
      for (let i = 0; i < 4; i++) {
        const task = await this.exclusive(() => {
          const message = this.state.messages.find(m => m.status === "pending" && m.nextAttempt <= this.now());
          if (!message) return;
          const subscription = this.activeSubscription(message.channelId);
          if (!subscription || subscription.id !== message.subscriptionId || message.attempts >= 3) {
            message.status = "failed"; message.issue = "Subscription expired/replaced or delivery limit reached"; this.save(); return;
          }
          message.status = "sending"; message.attempts++; this.save();
          const event = { eventId: message.id, name: EVENT, timestamp: message.createdAt,
            data: { channelId: message.channelId, requestId: message.id, text: message.text.slice(0, 1000) }, cursor: null };
          return { messageId: message.id, subscription: structuredClone(subscription), body: JSON.stringify(event) };
        });
        if (!task) break;
        let status = 0, retryAfterMs = 0;
        try {
          if (this.authorizeDelivery && await this.authorizeDelivery(task.subscription.authorization) !== task.subscription.owner) {
            await this.exclusive(() => {
              this.state.subscriptions = this.state.subscriptions.filter(s => s.id !== task.subscription.id);
              const message = this.state.messages.find(m => m.id === task.messageId)!;
              if (message.status === "sending") { message.status = "failed"; message.issue = "OAuth access expired or revoked; renew the dot subscription."; }
              this.save();
            });
            continue;
          }
          const stillActive = await this.exclusive(() => this.state.messages.some(m => m.id === task.messageId && m.status === "sending")
            && this.activeSubscription(task.subscription.channelId)?.id === task.subscription.id);
          if (!stillActive) continue;
          const result = await this.post(task.subscription.url, task.subscription.secret, task.subscription.id, task.messageId, task.body,
            (task.subscription.previousSecretExpires ?? 0) > this.now() ? task.subscription.previousSecret : undefined);
          status = result.status; retryAfterMs = result.retryAfterMs ?? 0;
        } catch { /* Network failure is recorded without leaking URL or credentials. */ }
        await this.exclusive(() => {
          const message = this.state.messages.find(m => m.id === task.messageId)!;
          if (message.status !== "sending") return; // A report or cancellation may already have arrived.
          if (status >= 200 && status < 300) message.status = "accepted";
          else {
            const retryable = status === 0 || status === 429 || status >= 500;
            message.status = retryable && message.attempts < 3 ? "pending" : "failed";
            message.issue = status ? `Webhook HTTP ${status}` : "Webhook connection failed";
            message.nextAttempt = this.now() + Math.max(Math.min(retryAfterMs, 86400000), 30000 * 2 ** (message.attempts - 1));
            if (status === 410) this.state.subscriptions = this.state.subscriptions.filter(s => s.id !== task.subscription.id);
          }
          this.save();
        });
      }
    } finally { this.pumping = false; }
  }

  private authorizeMessage(owner: string, requestId: string): Message {
    const message = this.state.messages.find(m => m.id === requestId);
    if (!message || !this.state.channels.some(c => c.id === message.channelId && c.owner === owner)) throw Error("DOT_REQUEST_NOT_FOUND");
    return message;
  }
  private subscriptionInput(owner: string, params: Record<string, unknown>) {
    const args = params.arguments as Record<string, unknown> | undefined;
    const delivery = params.delivery as Record<string, unknown> | undefined;
    const channel = this.state.channels.find(c => c.id === args?.channelId && c.owner === owner);
    if (params.name !== EVENT || !channel || Object.keys(args ?? {}).some(k => k !== "channelId")
      || delivery?.mode !== "webhook" || typeof delivery.url !== "string") throw Error("INVALID_SUBSCRIPTION");
    return { channel, delivery };
  }
  private channelForChat(botId: string, chatId: string) { return this.state.channels.find(c => c.botId === botId && c.chatId === chatId); }
  private activeSubscription(channelId: string) { return this.state.subscriptions.find(s => s.channelId === channelId && s.expires > this.now()); }
  private prune() {
    this.state.subscriptions = this.state.subscriptions.filter(s => s.expires > this.now());
    this.state.messages = this.state.messages.filter(m => !["completed", "canceled", "failed"].includes(m.status)
      || (this.state.messages.length < CAPACITY && Date.parse(m.createdAt) > this.now() - 7 * 86400000));
  }
  private exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.storageFailed) throw Error("DOT_STORAGE_FAILED");
      return action();
    });
    this.tail = result.catch(() => {}); return result;
  }
  private save(): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, this.file); }
    catch { this.storageFailed = true; throw Error("DOT_STORAGE_FAILED"); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
}

export const DOT_EVENT_DEFINITION = {
  name: EVENT, description: "A user message in an explicitly dot-connected Telegram chat. Read the complete request with dot_read_request.",
  delivery: ["webhook"], inputSchema: { type: "object", properties: { channelId: { type: "string" } }, required: ["channelId"], additionalProperties: false },
  payloadSchema: { type: "object", properties: { channelId: { type: "string" }, requestId: { type: "string" }, text: { type: "string" } },
    required: ["channelId", "requestId", "text"], additionalProperties: false },
};
