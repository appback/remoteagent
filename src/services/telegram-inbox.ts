import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Update } from "grammy/types";

export type InboxEntry = {
  id: number;
  status: "pending" | "dispatching" | "done" | "needs_review";
  update?: Update;
  receivedAt: string;
  reason?: string;
  notified?: boolean;
};
type InboxFile = { version: 1; offset: number; entries: InboxEntry[] };

// Persist payloads BEFORE Telegram is acknowledged. Started work is never blindly replayed.
export class TelegramInbox {
  private readonly deferred = new Set<number>();
  private state?: InboxFile;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(dataDir: string, botId: string) {
    if (!/^\d+$/.test(botId)) throw Error("Invalid inbox bot ID");
    this.file = path.join(dataDir, "telegram-inbox", `${botId}.json`);
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async load(): Promise<InboxFile> {
    if (this.state) return this.state;
    let state: InboxFile;
    try { state = JSON.parse(await fs.readFile(this.file, "utf8")) as InboxFile; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      state = { version: 1, offset: 0, entries: [] };
    }
    if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0 || !Array.isArray(state.entries)
      || state.entries.some(e => !Number.isSafeInteger(e.id) || !["pending","dispatching","done","needs_review"].includes(e.status)
        || (e.status !== "done" && (!e.update || e.update.update_id !== e.id)))) throw Error("Invalid Telegram inbox; refusing acknowledgement");
    for (const entry of state.entries) if (entry.status === "dispatching") {
      entry.status = "needs_review";
      entry.reason = "실행 도중 서버가 중단되어 처리 결과를 확인할 수 없습니다.";
      entry.notified = false;
    }
    await this.save(state);
    return this.state!;
  }
  private async save(state: InboxFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temp, this.file);
      this.state = state;
    } finally { await fs.rm(temp, { force: true }); }
  }
  async snapshot(): Promise<InboxFile> { return this.serial(async () => structuredClone(await this.load())); }
  defer(id: number): boolean {
    if (!this.state?.entries.some(e => e.id === id && e.status === "dispatching")) return false;
    this.deferred.add(id);
    return true;
  }
  consumeDeferral(id: number): boolean { return this.deferred.delete(id); }
  async accept(updates: Update[]): Promise<void> {
    if (updates.length === 0) return;
    return this.serial(async () => {
      const state = structuredClone(await this.load());
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw Error("Invalid update ID");
        if (!state.entries.some(e => e.id === update.update_id)) state.entries.push({
          id: update.update_id, status: "pending", update, receivedAt: new Date().toISOString(),
        });
        state.offset = Math.max(state.offset, update.update_id + 1);
      }
      const outstanding = state.entries.filter(e => e.status !== "done");
      if (outstanding.length > 1000) throw Error("Telegram inbox is full; pending messages preserved, new updates not acknowledged");
      state.entries = [...state.entries.filter(e => e.status === "done").slice(-10000), ...outstanding];
      await this.save(state);
    });
  }
  async transition(id: number, status: InboxEntry["status"], reason?: string): Promise<void> {
    return this.serial(async () => {
      const state = structuredClone(await this.load());
      const entry = state.entries.find(e => e.id === id);
      if (!entry) throw Error("Inbox entry missing");
      entry.status = status;
      entry.reason = reason;
      entry.notified = false;
      if (status === "done") delete entry.update;
      await this.save(state);
    });
  }
  async decide(id: number, chatId: string, retry: boolean): Promise<boolean> {
    return this.serial(async () => {
      const state = structuredClone(await this.load());
      const entry = state.entries.find(e => e.id === id);
      if (!entry || entry.status !== "needs_review" || String(entry.update && "message" in entry.update
        ? entry.update.message?.chat.id : "") !== chatId) return false;
      entry.status = retry ? "pending" : "done";
      entry.notified = true;
      if (!retry) delete entry.update;
      await this.save(state);
      return true;
    });
  }
  async notified(id: number): Promise<void> {
    return this.serial(async () => {
      const state = structuredClone(await this.load());
      const entry = state.entries.find(e => e.id === id);
      if (entry) entry.notified = true;
      await this.save(state);
    });
  }
}

const instances = new Map<string, TelegramInbox>();
export function telegramInbox(dataDir: string, botId: string): TelegramInbox {
  const key = `${path.resolve(dataDir)}:${botId}`;
  if (!instances.has(key)) instances.set(key, new TelegramInbox(dataDir, botId));
  return instances.get(key)!;
}
