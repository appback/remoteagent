import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { BridgeService } from "./bridge-service.js";
import type { DotBridgeService } from "./dot-bridge-service.js";
import type { G2Principal } from "./g2-config.js";

type Status = "accepted" | "running" | "completed" | "failed" | "cancel_requested" | "canceled" | "interrupted";
type Target = { targetId: string; type: "session" | "dot_channel"; provider: "codex" | "claude" | "dot";
  label: string; available: boolean; cancelMode: "execution" | "delivery_only"; reference: string };
type Event = { seq: number; type: string; at: string; text?: string; outcome?: string; error?: string; truncated?: boolean };
type Row = { requestId: string; subject: string; clientId: string; clientRequestId: string; target: Target; text: string;
  fingerprint: string; status: Status; createdAt: string; updatedAt: string; events: Event[]; lastSeq: number;
  reports: Record<string, string>; result?: { text: string; outcome: string; truncated: boolean }; error?: string;
  cancel?: { scope: "execution" | "delivery_only"; confirmed: boolean; executionStopped: boolean } };
const terminal = (status: Status) => ["completed", "failed", "canceled", "interrupted"].includes(status);
const RETENTION = 7 * 86400000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Sessions = Pick<BridgeService, "listSessions" | "isSessionBusy" | "isProviderAvailable" | "routeExternalMessage">;

export class G2RequestService {
  private readonly dir: string;
  private readonly key: Buffer;
  private rows = new Map<string, Row>();
  private controllers = new Map<string, AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
  private storageFailed = false;

  constructor(dataDir: string, private readonly owner: string, private readonly sessions: Sessions,
    private readonly dot: DotBridgeService, private readonly now: () => number = Date.now) {
    this.dir = path.join(dataDir, "g2", "requests");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(dataDir, "g2", "target-key");
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw Error("G2_TARGET_KEY_INVALID");
    for (const name of fs.readdirSync(this.dir).filter(name => /^req_[a-f0-9-]{36}\.json$/.test(name))) {
      const row = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as Row;
      if (row.subject !== owner || name !== `${row.requestId}.json`) throw Error("G2_STORE_INVALID");
      this.rows.set(row.requestId, row);
    }
    this.prune();
    this.dot.setExternalReporter((...args) => this.dotReport(...args));
  }

  async restore(): Promise<void> {
    for (const row of this.rows.values()) {
      if (terminal(row.status)) continue;
      row.status = "interrupted"; row.error = "RUNTIME_RESTARTED";
      this.event(row, "interrupted", { error: row.error });
      if (row.target.type === "dot_channel") await this.dot.cancelExternal(this.owner, row.requestId);
    }
  }

  private id(type: string, reference: string, provider: string) {
    return "tgt_" + createHmac("sha256", this.key).update(JSON.stringify([type, reference, provider])).digest("hex").slice(0, 32);
  }
  // Operator-only inventory; the HTTP API always calls targets(principal).
  async inventory(): Promise<Target[]> {
    const sessions = await this.sessions.listSessions();
    return [...sessions.map(session => ({ targetId: this.id("session", session.sessionId, session.mode), type: "session" as const,
      reference: session.sessionId, provider: session.mode, label: session.publicId,
      available: Boolean(session[session.mode]) && this.sessions.isProviderAvailable(session.mode) && !this.sessions.isSessionBusy(session.sessionId), cancelMode: "execution" as const })),
    ...this.dot.externalChannels(this.owner).map(channel => ({ targetId: this.id("dot_channel", channel.channelId, "dot"),
      reference: channel.channelId, type: "dot_channel" as const, provider: "dot" as const, label: "dot " + channel.channelId,
      available: channel.available, cancelMode: "delivery_only" as const }))];
  }
  async targets(principal: G2Principal) {
    this.authorize(principal);
    return (await this.inventory()).filter(target => principal.targetIds.includes(target.targetId)).map(({ reference: _ref, ...target }) => ({
      ...target, available: target.available && ![...this.rows.values()].some(row => row.target.targetId === target.targetId && !terminal(row.status)),
    }));
  }
  async submit(principal: G2Principal, input: Record<string, unknown>) {
    return this.exclusive(async () => {
      this.authorize(principal); this.prune();
      if (Object.keys(input).some(key => !["targetId", "text", "clientRequestId"].includes(key))
        || typeof input.targetId !== "string" || typeof input.text !== "string" || !input.text.trim()
        || typeof input.clientRequestId !== "string"
        || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.clientRequestId)) throw Error("INVALID_REQUEST");
      if (Buffer.byteLength(input.text) > 32768) throw Error("REQUEST_TOO_LARGE");
      if (!principal.targetIds.includes(input.targetId)) throw Error("TARGET_FORBIDDEN");
      const fingerprint = digest(JSON.stringify([input.targetId, input.text]));
      const old = [...this.rows.values()].find(row => row.subject === principal.subject && row.clientId === principal.clientId && row.clientRequestId === input.clientRequestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw Error("REQUEST_ID_CONFLICT");
        return { ...this.snapshot(old), replayed: true };
      }
      const target = (await this.inventory()).find(target => target.targetId === input.targetId);
      if (!target) throw Error("TARGET_NOT_FOUND");
      if ([...this.rows.values()].some(row => row.target.targetId === target.targetId && !terminal(row.status))) throw Error("TARGET_BUSY");
      if (!target.available) throw Error(target.type === "dot_channel" ? "DOT_NOT_SUBSCRIBED"
        : this.sessions.isSessionBusy(target.reference) ? "TARGET_BUSY" : "TARGET_UNAVAILABLE");
      if (this.rows.size >= 128) throw Error("REQUEST_CAPACITY");
      const now = new Date(this.now()).toISOString();
      const row: Row = { requestId: "req_" + randomUUID(), subject: principal.subject, clientId: principal.clientId,
        clientRequestId: input.clientRequestId, fingerprint, text: input.text, target,
        status: "accepted", createdAt: now, updatedAt: now, events: [], lastSeq: 0, reports: {} };
      this.rows.set(row.requestId, row);
      try { this.event(row, "accepted"); } catch (error) { this.rows.delete(row.requestId); throw error; }
      const accepted = { ...this.snapshot(row), replayed: false };
      const controller = new AbortController(); this.controllers.set(row.requestId, controller);
      queueMicrotask(() => { void this.execute(row, controller).catch(() => console.error("G2 request state could not be persisted; new G2 requests are paused.")); });
      return accepted;
    });
  }
  get(principal: G2Principal, requestId: string) {
    const row = this.find(principal, requestId); this.reconcile(row); return this.snapshot(row);
  }
  events(principal: G2Principal, requestId: string, after: number, limit: number) {
    const row = this.find(principal, requestId); this.reconcile(row);
    if (!Number.isSafeInteger(after) || after < 0 || after > row.lastSeq || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("INVALID_CURSOR");
    if (after < (row.events[0]?.seq ?? 1) - 1) throw Error("CURSOR_EXPIRED");
    const events = row.events.filter(event => event.seq > after).slice(0, limit);
    const nextCursor = events.at(-1)?.seq ?? after;
    return { requestId, events, nextCursor, hasMore: nextCursor < row.lastSeq, status: row.status };
  }
  async cancel(principal: G2Principal, requestId: string) {
    return this.exclusive(async () => {
      const row = this.find(principal, requestId); this.reconcile(row);
      if (terminal(row.status) || row.status === "cancel_requested") return this.snapshot(row);
      row.status = "cancel_requested";
      row.cancel = { scope: row.target.cancelMode, confirmed: false, executionStopped: false };
      this.event(row, "cancel_requested");
      if (row.target.type === "dot_channel") {
        await this.dot.cancelExternal(this.owner, row.requestId);
        row.status = "canceled"; row.cancel.confirmed = true;
        this.event(row, "canceled");
      } else { this.controllers.get(requestId)?.abort(); }
      return this.snapshot(row);
    });
  }

  private async execute(row: Row, controller: AbortController) {
    try {
      if (terminal(row.status) || row.status === "cancel_requested") { this.finishCancellation(row); return; }
      if (row.target.type === "dot_channel") {
        await this.dot.enqueueExternal(this.owner, row.target.reference, row.requestId, row.text);
      } else {
        const responses = await this.sessions.routeExternalMessage(row.target.reference, row.target.provider as "codex" | "claude", row.text,
          controller.signal, () => { row.status = "running"; this.event(row, "running"); },
          response => { if (!terminal(row.status) && row.status !== "cancel_requested") this.event(row, "progress", { text: response.output }); });
        if (controller.signal.aborted) { this.finishCancellation(row); return; }
        const text = responses.map(response => response.output).join("\n\n");
        if (!text.trim()) throw Error("PROVIDER_EMPTY_RESULT");
        row.result = this.result(text, "unknown"); row.status = "completed";
        this.event(row, "result", { text: row.result.text, outcome: "unknown", truncated: row.result.truncated });
      }
    } catch (error) {
      if (controller.signal.aborted) { this.finishCancellation(row); return; }
      if (terminal(row.status)) return;
      row.status = "failed";
      row.error = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "PROVIDER_EXECUTION_FAILED";
      try { this.event(row, "error", { error: row.error }); } catch { /* Storage failure pauses new requests. */ }
    } finally { this.controllers.delete(row.requestId); }
  }
  private finishCancellation(row: Row) {
    if (row.status === "canceled") return;
    row.status = "canceled";
    row.cancel = { scope: row.target.cancelMode, confirmed: true, executionStopped: row.target.type === "session" };
    this.event(row, "canceled");
  }
  private dotReport(requestId: string, reportId: string, kind: "progress" | "result", text: string, outcome: string) {
    if (this.storageFailed) throw Error("G2_STORAGE_FAILED");
    const row = this.rows.get(requestId);
    if (!row || row.target.type !== "dot_channel") throw Error("G2_REQUEST_NOT_FOUND");
    const fingerprint = digest(JSON.stringify([kind, text, outcome]));
    const reportKey = `id:${reportId}`;
    if (row.reports[reportKey]) {
      if (row.reports[reportKey] !== fingerprint) throw Error("REPORT_ID_CONFLICT");
      return;
    }
    if (terminal(row.status) || row.status === "cancel_requested") throw Error("G2_REQUEST_CLOSED");
    if (Object.keys(row.reports).length >= 20) throw Error("DOT_REPORT_LIMIT");
    row.reports[reportKey] = fingerprint;
    if (kind === "result") { row.status = "completed"; row.result = this.result(text, outcome); }
    else row.status = "running";
    this.event(row, kind === "result" ? "result" : "progress", { text, ...(kind === "result" ? { outcome } : {}) });
  }
  private reconcile(row: Row) {
    if (row.target.type !== "dot_channel" || terminal(row.status) || row.status === "cancel_requested") return;
    let status: string;
    try { status = this.dot.read(this.owner, row.requestId).status; } catch { return; }
    if (status === "failed" || status === "canceled") {
      row.status = status; row.error = status === "failed" ? "DOT_DELIVERY_FAILED" : "DOT_CHANNEL_CANCELED";
      this.event(row, status === "failed" ? "error" : "canceled", { error: row.error });
    }
  }
  private authorize(principal: G2Principal) {
    if (this.storageFailed) throw Error("G2_STORAGE_FAILED");
    if (principal.subject !== this.owner || principal.expiresAt <= this.now()) throw Error("UNAUTHORIZED");
  }
  private find(principal: G2Principal, requestId: string) {
    this.authorize(principal); this.prune();
    const row = this.rows.get(requestId);
    if (!row || row.subject !== principal.subject || row.clientId !== principal.clientId) throw Error("REQUEST_NOT_FOUND");
    if (!principal.targetIds.includes(row.target.targetId)) throw Error("TARGET_FORBIDDEN");
    return row;
  }
  private result(text: string, outcome: string) { return { text: text.slice(0, 16384), outcome, truncated: text.length > 16384 }; }
  private snapshot(row: Row) {
    return { requestId: row.requestId, clientRequestId: row.clientRequestId, targetId: row.target.targetId, status: row.status,
      createdAt: row.createdAt, updatedAt: row.updatedAt, lastSeq: row.lastSeq, ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}), ...(row.cancel ? { cancel: { ...row.cancel } } : {}) };
  }
  private event(row: Row, type: string, data: Omit<Event, "seq" | "type" | "at"> = {}) {
    const text = data.text?.slice(0, 16384);
    row.updatedAt = new Date(this.now()).toISOString();
    row.events.push({ ...data, ...(text === undefined ? {} : { text, truncated: data.truncated || data.text!.length > text.length }),
      seq: ++row.lastSeq, type, at: row.updatedAt });
    while (row.events.length > 128 || Buffer.byteLength(JSON.stringify(row.events)) > 256 * 1024) row.events.shift();
    this.save(row);
  }
  private save(row: Row) {
    const file = path.join(this.dir, row.requestId + ".json"), temp = file + "." + randomUUID() + ".tmp";
    try { fs.writeFileSync(temp, JSON.stringify(row), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
    catch { this.storageFailed = true; throw Error("G2_STORAGE_FAILED"); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  private prune() {
    for (const row of this.rows.values()) if (terminal(row.status) && Date.parse(row.updatedAt) < this.now() - RETENTION) {
      fs.rmSync(path.join(this.dir, row.requestId + ".json"), { force: true }); this.rows.delete(row.requestId);
    }
  }
  private exclusive<T>(task: () => Promise<T>) {
    const result = this.tail.then(task); this.tail = result.catch(() => undefined); return result;
  }
}
