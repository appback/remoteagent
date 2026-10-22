import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

type Operation = { requestId: string; operationId: string; fingerprint: string;
  jobId?: string; status: "sending" | "done" | "unknown"; result?: unknown };
type Binding = { requestId: string; jobId: string; closed?: boolean };
type State = { version: 1; operations: Operation[]; bindings: Binding[] };
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class DotWebatonService {
  private readonly file: string;
  private readonly base: string;
  private state: State;
  private tail: Promise<unknown> = Promise.resolve();
  private canceled = new Set<string>();
  private storageFailed = false;
  constructor(dataDir: string, url: string, private readonly tokenFile: string,
    private readonly fetcher: typeof fetch = fetch) {
    const base = new URL(url);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.pathname !== "/"
      || base.search || base.hash || base.username || base.password || !path.isAbsolute(tokenFile)) throw Error("WEBATON_CONFIGURATION_INVALID");
    this.base = base.origin;
    this.token();
    const dir = path.join(dataDir, "dot");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "webaton.json");
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : { version: 1, operations: [], bindings: [] };
    if (this.state.version !== 1) throw Error("WEBATON_STATE_INVALID");
    for (const op of this.state.operations) if (op.status === "sending") op.status = "unknown";
    this.save();
  }
  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    return this.exclusive(async () => {
      const requestId = input.requestId;
      if (typeof requestId !== "string" || !requestId) throw Error("INVALID_WEBATON_ARGUMENTS");
      if (name === "dot_webaton_accounts") {
        const accounts = await this.api("/api/accounts");
        if (!Array.isArray(accounts)) throw Error("WEBATON_INVALID_RESPONSE");
        return { accounts: accounts.map(a => ({ id: a.id, name: a.name, mode: a.mode })) };
      }
      if (name === "dot_webaton_begin") {
        if (typeof input.accountId !== "string" || !uuid.test(input.accountId) || typeof input.instruction !== "string"
          || !input.instruction.trim() || input.instruction.length > 4000) throw Error("INVALID_WEBATON_ARGUMENTS");
        return this.mutate(requestId, input.operationId, name, { accountId: input.accountId, instruction: input.instruction }, undefined, async () => {
          const job = await this.api("/api/jobs", { accountId: input.accountId, instruction: input.instruction, mode: "external" });
          if (typeof job.id !== "string" || !uuid.test(job.id) || job.mode !== "external") throw Error("WEBATON_INVALID_RESPONSE");
          this.state.bindings.push({ requestId, jobId: job.id, closed: terminal.has(job.status) });
          return this.publicJob(job);
        });
      }
      const jobId = input.jobId;
      if (typeof jobId !== "string" || !uuid.test(jobId)) throw Error("INVALID_WEBATON_ARGUMENTS");
      const binding = this.state.bindings.find(b => b.requestId === requestId && b.jobId === jobId);
      if (!binding) throw Error("WEBATON_JOB_NOT_OWNED");
      if (name === "dot_webaton_forget") {
        const jobs = await this.api("/api/jobs");
        const job = Array.isArray(jobs) ? jobs.find(j => j.id === jobId) : undefined;
        if (!job || !terminal.has(job.status)) throw Error("WEBATON_JOB_NOT_TERMINAL");
        this.state.bindings = this.state.bindings.filter(b => b !== binding);
        this.state.operations = this.state.operations.filter(o => !(o.requestId === requestId && (o.jobId === jobId
          || (o.result as { id?: string } | undefined)?.id === jobId)));
        this.save(); return { removed: jobId, warning: "Retry records removed. Never retry the original operations." };
      }
      if (name === "dot_webaton_job") {
        const jobs = await this.api("/api/jobs");
        if (!Array.isArray(jobs)) throw Error("WEBATON_INVALID_RESPONSE");
        const job = jobs.find(j => j.id === jobId);
        if (!job) throw Error("WEBATON_JOB_NOT_FOUND");
        binding.closed = terminal.has(job.status); this.save(); return this.publicJob(job);
      }
      if (name === "dot_webaton_observe") return { observation: await this.api(`/api/browser/${jobId}/observe`, {}),
        source: "Webaton Chromium on RemoteAgent host", untrustedPageData: true };
      if (!["dot_webaton_act", "dot_webaton_finish", "dot_webaton_resume", "dot_webaton_cancel"].includes(name)) throw Error("UNKNOWN_TOOL");
      const action = name === "dot_webaton_act" ? this.action(input.action) : {};
      const route = name === "dot_webaton_cancel" ? `/api/jobs/${jobId}/cancel`
        : `/api/browser/${jobId}/${name === "dot_webaton_act" ? "action" : name === "dot_webaton_finish" ? "finish" : "resume"}`;
      return this.mutate(requestId, input.operationId, name, action, jobId, async () => {
        const result = await this.api(route, action);
        if (name === "dot_webaton_finish" || name === "dot_webaton_cancel") binding.closed = true;
        return name === "dot_webaton_cancel" || name === "dot_webaton_resume" ? this.publicJob(result) : result;
      });
    });
  }
  async cancelRequest(requestId: string): Promise<void> {
    this.canceled.add(requestId);
    if (this.canceled.size > 1024) this.canceled.delete(this.canceled.values().next().value!);
    await this.exclusive(async () => {
      for (const b of this.state.bindings.filter(b => b.requestId === requestId && !b.closed)) {
        // Only cancel jobs created through this adapter, never another Webaton user's work.
        await this.api(`/api/jobs/${b.jobId}/cancel`, {});
        b.closed = true; this.save();
      }
    });
  }
  hasActiveRequest(requestId: string) { return this.state.bindings.some(b => b.requestId === requestId && !b.closed); }
  private action(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_WEBATON_ACTION");
    const a = value as Record<string, unknown>;
    const allowed = a.type === "navigate" ? ["type", "url"] : a.type === "fill" ? ["type", "selector", "value"] : ["type", "selector"];
    if (Object.keys(a).some(k => !allowed.includes(k))) throw Error("INVALID_WEBATON_ACTION");
    if (a.type === "navigate") {
      if (typeof a.url !== "string" || a.url.length > 4096) throw Error("INVALID_WEBATON_ACTION");
      const u = new URL(a.url);
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw Error("INVALID_WEBATON_ACTION");
    } else if (!["click", "fill", "download"].includes(String(a.type)) || typeof a.selector !== "string"
      || !a.selector.trim() || a.selector.length > 200) throw Error("INVALID_WEBATON_ACTION");
    if (a.type === "fill" && (typeof a.value !== "string" || a.value.length > 2000)) throw Error("INVALID_WEBATON_ACTION");
    return a;
  }
  private async mutate(requestId: string, operationId: unknown, name: string, body: unknown, jobId: string | undefined,
    perform: () => Promise<unknown>) {
    if (this.canceled.has(requestId)) throw Error("WEBATON_REQUEST_CANCELED");
    if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(operationId)) throw Error("INVALID_WEBATON_ARGUMENTS");
    const fingerprint = createHash("sha256").update(JSON.stringify([name, jobId, body])).digest("hex");
    const old = this.state.operations.find(o => o.requestId === requestId && o.operationId === operationId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw Error("WEBATON_OPERATION_ID_CONFLICT");
      if (old.status !== "done") throw Error("WEBATON_OUTCOME_UNKNOWN: do not repeat the action; inspect the browser and job state.");
      return old.result;
    }
    if (name !== "dot_webaton_cancel" && this.state.operations.some(o => o.requestId === requestId && o.status === "unknown"))
      throw Error("WEBATON_OUTCOME_UNKNOWN: an earlier action is ambiguous; inspect before further changes.");
    if (this.state.operations.length >= 512 || this.state.bindings.length >= 128) throw Error("WEBATON_HISTORY_FULL");
    const op: Operation = { requestId, operationId, fingerprint, jobId, status: "sending" };
    this.state.operations.push(op); this.save();
    try {
      const result = await perform();
      if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw Error("WEBATON_OPERATION_RESULT_TOO_LARGE");
      op.result = result; op.status = "done"; this.save(); return result;
    } catch (error) {
      op.status = "unknown"; this.save();
      throw error;
    }
  }
  private publicJob(job: Record<string, any>) {
    return { id: job.id, accountId: job.accountId, mode: job.mode, status: job.status, index: job.index,
      createdAt: job.createdAt, expiresAt: job.expiresAt, note: job.note,
      events: Array.isArray(job.events) ? job.events.slice(-10).map((e: any) => ({ at: e.at, type: e.type })) : [],
      files: Array.isArray(job.files) ? job.files.map((f: any) => ({ file: f.file, bytes: f.bytes })) : [] };
  }
  private token() {
    const stat = fs.statSync(this.tokenFile);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw Error("WEBATON_TOKEN_FILE_NOT_PRIVATE");
    const value = fs.readFileSync(this.tokenFile, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw Error("WEBATON_TOKEN_INVALID");
    return value;
  }
  private async api(route: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(this.base + route, { method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { "content-type": "application/json", "x-agent-token": this.token() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
    } catch { throw Error("WEBATON_CONNECTION_FAILED: outcome may be unknown; no automatic action retry."); }
    const chunks: Buffer[] = []; let size = 0;
    if (!response.body) throw Error("WEBATON_INVALID_RESPONSE");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 262144) { await response.body.cancel().catch(() => {}); throw Error("WEBATON_RESPONSE_TOO_LARGE"); }
      chunks.push(Buffer.from(chunk));
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw Error("WEBATON_ACCESS_DENIED");
      let reason: unknown;
      try { reason = JSON.parse(Buffer.concat(chunks).toString("utf8")).error; } catch { /* Return a fixed error below. */ }
      if (typeof reason === "string" && ["AUTH_REQUIRED", "AUTH_NOT_COMPLETE", "AUTH_EXPIRED", "INVALID_STATE", "BROWSER_BUSY",
        "ACCOUNT_NOT_FOUND", "JOB_NOT_FOUND", "STEP_LIMIT", "ORIGIN_NOT_ALLOWED", "SENSITIVE_INPUT_BLOCKED"].includes(reason))
        throw Error(`WEBATON_${reason}`);
      throw Error("WEBATON_OPERATION_FAILED: inspect job or authenticate in Webaton; no automatic retry.");
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Error("WEBATON_INVALID_RESPONSE"); }
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { if (this.storageFailed) throw Error("WEBATON_STORAGE_FAILED"); return action(); });
    this.tail = result.catch(() => {}); return result;
  }
  private save() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(this.state), { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, this.file); }
    catch { this.storageFailed = true; throw Error("WEBATON_STORAGE_FAILED"); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
}
