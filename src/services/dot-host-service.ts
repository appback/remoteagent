import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type Job = { id: string; requestId: string; operationId: string; fingerprint: string; cwd: string;
  status: "running" | "succeeded" | "failed" | "canceled" | "timed_out" | "interrupted";
  startedAt: string; finishedAt?: string; exitCode?: number | null; signal?: string | null;
  stdout: string; stderr: string; truncated: boolean };
const OUTPUT_LIMIT = 32768;

// This is owner-authorized host execution, not an OS sandbox. Roots constrain file tools and cwd only.
export class DotHostService {
  private readonly roots: string[];
  private readonly file: string;
  private jobs: Job[];
  private children = new Map<string, { child: ChildProcess; timer: NodeJS.Timeout; killTimer?: NodeJS.Timeout }>();
  private readonly onExit = () => this.close();
  private closed = false;
  private storageFailed = false;
  constructor(dataDir: string, roots: string[]) {
    if (!roots.length || process.platform === "win32") throw Error("DOT_HOST_CONFIGURATION_INVALID");
    this.roots = roots.map(root => {
      if (!path.isAbsolute(root)) throw Error("DOT_HOST_ROOT_MUST_BE_ABSOLUTE");
      const real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory() || real === path.parse(real).root) throw Error("DOT_HOST_ROOT_INVALID");
      return real;
    });
    const dir = path.join(dataDir, "dot");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "host-jobs.json");
    this.jobs = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
    for (const job of this.jobs) if (job.status === "running") {
      job.status = "interrupted"; job.finishedAt = new Date().toISOString();
    }
    this.save();
    process.once("exit", this.onExit);
  }
  info() { return { platform: process.platform, hostname: os.hostname(), roots: this.roots,
    shell: "/bin/bash", executionIdentity: "RemoteAgent OS user", sandbox: false,
    maxConcurrentJobs: 2, maxTimeoutSeconds: 3600, outputLimitBytesPerStream: OUTPUT_LIMIT,
    jobs: this.jobs.map(j => ({ id: j.id, requestId: j.requestId, status: j.status, startedAt: j.startedAt })) }; }
  hasActiveRequest(requestId: string) {
    return this.jobs.some(job => job.requestId === requestId && this.children.has(job.id));
  }

  start(requestId: string, input: Record<string, unknown>) {
    if (this.closed || this.storageFailed) throw Error("HOST_EXECUTION_UNAVAILABLE");
    this.validate(input, ["requestId", "operationId", "command", "cwd", "timeoutSeconds"]);
    if (typeof input.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.operationId)
      || typeof input.command !== "string" || !input.command.trim() || Buffer.byteLength(input.command) > 16384
      || typeof input.cwd !== "string") throw Error("INVALID_HOST_ARGUMENTS");
    const seconds = input.timeoutSeconds ?? 600;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw Error("INVALID_HOST_TIMEOUT");
    const cwd = this.resolve(input.cwd);
    if (!fs.statSync(cwd).isDirectory()) throw Error("HOST_CWD_NOT_DIRECTORY");
    const fingerprint = createHash("sha256").update(JSON.stringify([input.command, cwd, seconds])).digest("hex");
    const previous = this.jobs.find(j => j.requestId === requestId && j.operationId === input.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error("HOST_OPERATION_ID_CONFLICT");
      return this.snapshot(previous);
    }
    if (this.children.size >= 2) throw Error("HOST_JOB_LIMIT");
    if (this.jobs.length >= 64) throw Error("HOST_JOB_HISTORY_FULL");
    const job: Job = { id: randomUUID(), requestId, operationId: input.operationId, fingerprint, cwd,
      status: "running", startedAt: new Date().toISOString(), stdout: "", stderr: "", truncated: false };
    this.jobs.push(job);
    if (!this.persist()) { job.status = "failed"; throw Error("HOST_STORAGE_UNAVAILABLE"); }
    // Do not forward RemoteAgent's bot tokens, OAuth secrets or secret-helper configuration.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"])
      if (process.env[key]) env[key] = process.env[key];
    let child: ChildProcess;
    try { child = spawn("/bin/bash", ["-c", input.command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { job.status = "failed"; job.finishedAt = new Date().toISOString(); this.persist(); throw Error("HOST_SPAWN_FAILED"); }
    const timer = setTimeout(() => this.stop(job, "timed_out"), seconds * 1000);
    timer.unref();
    this.children.set(job.id, { child, timer });
    const streams = { stdout: { bytes: 0, decoder: new StringDecoder("utf8") }, stderr: { bytes: 0, decoder: new StringDecoder("utf8") } };
    const append = (key: "stdout" | "stderr", chunk: Buffer) => {
      const stream = streams[key];
      const remaining = OUTPUT_LIMIT - stream.bytes;
      if (chunk.length > remaining) job.truncated = true;
      if (remaining > 0) {
        const part = chunk.subarray(0, remaining);
        stream.bytes += part.length;
        job[key] += stream.decoder.write(part);
      }
    };
    child.stdout!.on("data", chunk => append("stdout", chunk));
    child.stderr!.on("data", chunk => append("stderr", chunk));
    child.once("error", () => { job.status = "failed"; });
    child.once("close", (code, signal) => {
      const entry = this.children.get(job.id);
      if (entry) { clearTimeout(entry.timer); if (entry.killTimer) clearTimeout(entry.killTimer); }
      // Kill remaining descendants before forgetting the process group.
      if (child.pid) this.kill(child.pid, "SIGKILL");
      this.children.delete(job.id);
      if (job.status === "running") job.status = code === 0 ? "succeeded" : "failed";
      job.exitCode = code; job.signal = signal; job.finishedAt = new Date().toISOString();
      if (!this.closed) this.persist();
    });
    return this.snapshot(job);
  }
  status(requestId: string, jobId: unknown) { return this.snapshot(this.job(requestId, jobId)); }
  cancel(requestId: string, jobId: unknown) {
    const job = this.job(requestId, jobId);
    if (job.status === "running") this.stop(job, "canceled");
    return this.snapshot(job);
  }
  cancelRequest(requestId: string) {
    for (const job of this.jobs) if (job.requestId === requestId && job.status === "running") this.stop(job, "canceled");
  }
  forget(requestId: string, jobId: unknown) {
    const job = this.job(requestId, jobId);
    if (this.children.has(job.id)) throw Error("HOST_JOB_STILL_RUNNING");
    this.jobs = this.jobs.filter(j => j !== job); this.save();
    return { removed: job.id, warning: "Operation idempotency record removed; do not retry the original start call." };
  }
  fileOperation(input: Record<string, unknown>) {
    this.validate(input, ["requestId", "action", "path", "content", "expectedSha256"]);
    if (typeof input.path !== "string" || !["list", "read", "write"].includes(String(input.action))) throw Error("INVALID_HOST_ARGUMENTS");
    const writing = input.action === "write";
    const target = this.resolve(input.path, writing);
    if (input.action === "list") {
      const dir = fs.opendirSync(target);
      const entries = [];
      try {
        let entry;
        while (entries.length < 500 && (entry = dir.readSync())) entries.push({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() });
        return { path: target, entries, truncated: entries.length === 500 && dir.readSync() !== null };
      } finally { dir.closeSync(); }
    }
    const exists = fs.existsSync(target);
    let bytes: Buffer | undefined;
    if (exists) {
      if (!fs.statSync(target).isFile() || fs.statSync(target).size > OUTPUT_LIMIT) throw Error("HOST_FILE_TOO_LARGE_OR_NOT_REGULAR");
      bytes = fs.readFileSync(target);
    }
    const sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    if (!writing) {
      if (!bytes) throw Error("HOST_FILE_NOT_FOUND");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw Error("HOST_FILE_NOT_UTF8"); }
      return { path: target, content, sha256 };
    }
    if (typeof input.content !== "string" || Buffer.byteLength(input.content) > OUTPUT_LIMIT
      || !(input.expectedSha256 === null || typeof input.expectedSha256 === "string")) throw Error("INVALID_HOST_ARGUMENTS");
    if (input.expectedSha256 !== sha256) throw Error("HOST_FILE_CHANGED");
    const temp = path.join(path.dirname(target), `.dot-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, input.content, { flag: "wx", mode: exists ? fs.statSync(target).mode & 0o777 : 0o600 });
      fs.renameSync(temp, target);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return { path: target, sha256: createHash("sha256").update(input.content).digest("hex"), bytes: Buffer.byteLength(input.content) };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    process.removeListener("exit", this.onExit);
    for (const [id, entry] of this.children) {
      clearTimeout(entry.timer); if (entry.killTimer) clearTimeout(entry.killTimer);
      if (entry.child.pid) this.kill(entry.child.pid, "SIGKILL");
      const job = this.jobs.find(j => j.id === id)!;
      job.status = "interrupted"; job.finishedAt = new Date().toISOString();
    }
    this.children.clear(); this.persist();
  }
  private snapshot(job: Job) { const { fingerprint: _, ...result } = job; return { ...result }; }
  private job(requestId: string, id: unknown) {
    const job = this.jobs.find(j => j.id === id && j.requestId === requestId);
    if (!job) throw Error("HOST_JOB_NOT_FOUND"); return job;
  }
  private stop(job: Job, status: "canceled" | "timed_out") {
    const entry = this.children.get(job.id);
    if (!entry) return;
    job.status = status;
    if (entry.child.pid) this.kill(entry.child.pid, "SIGTERM");
    entry.killTimer = setTimeout(() => { if (entry.child.pid) this.kill(entry.child.pid, "SIGKILL"); }, 2000);
    entry.killTimer.unref(); this.persist();
  }
  private kill(pid: number, signal: NodeJS.Signals) { try { process.kill(-pid, signal); } catch { /* Already exited. */ } }
  private resolve(value: string, create = false) {
    if (!path.isAbsolute(value)) throw Error("HOST_PATH_MUST_BE_ABSOLUTE");
    const resolved = path.resolve(value);
    let real: string;
    if (create && !fs.existsSync(resolved)) {
      if (fs.lstatSync(path.dirname(resolved)).isSymbolicLink()) throw Error("HOST_PATH_NOT_ALLOWED");
      real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
      try { if (fs.lstatSync(resolved).isSymbolicLink()) throw Error("HOST_PATH_NOT_ALLOWED"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    } else real = fs.realpathSync(resolved);
    if (!this.roots.some(root => real === root || real.startsWith(root + path.sep))) throw Error("HOST_PATH_NOT_ALLOWED");
    return real;
  }
  private validate(input: Record<string, unknown>, allowed: string[]) {
    if (Object.keys(input).some(k => !allowed.includes(k))) throw Error("INVALID_HOST_ARGUMENTS");
  }
  private save() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(this.jobs), { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  private persist() {
    try { this.save(); return true; }
    catch {
      if (!this.storageFailed) console.error("Dot host job persistence failed; new host executions are disabled.");
      this.storageFailed = true;
      return false;
    }
  }
}
