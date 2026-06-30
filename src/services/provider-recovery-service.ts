import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { BridgeState, ChatBinding, SessionRecord } from "../types.js";
import { BotPollingStateService } from "./bot-polling-state-service.js";

const execFileAsync = promisify(execFile);

type RecoveryBot = {
  botId: string;
  username?: string;
  token: string;
};

type NoticeFile = {
  version: 1;
  updatedAt: string;
  delivered: Record<string, string>;
};

type ReconcileResult = {
  checked: number;
  recovered: number;
};

const EMPTY_STATE: BridgeState = { chats: {}, sessions: {}, telegramContacts: {}, settings: {} };

export class ProviderRecoveryService {
  private readonly noticePath: string;

  constructor(
    private readonly dataDir: string,
    private readonly pollingState: BotPollingStateService,
  ) {
    this.noticePath = path.join(dataDir, "provider-recovery-notices.json");
  }

  async reconcileStaleRunningStates(bots: RecoveryBot[]): Promise<ReconcileResult> {
    const botById = new Map(bots.map((bot) => [bot.botId, bot]));
    const pollingStates = await this.pollingState.list();
    const runningEntries = Object.entries(pollingStates)
      .filter(([, state]) => state.runningSessionIds && state.runningSessionIds.length > 0);

    if (runningEntries.length === 0) {
      return { checked: 0, recovered: 0 };
    }

    const bridgeState = await this.readBridgeState();
    const processNeedles = await readProviderProcessNeedles();
    let checked = 0;
    let recovered = 0;

    for (const [botId, state] of runningEntries) {
      const bot = botById.get(botId);
      if (!bot) {
        continue;
      }

      const staleSessionIds: string[] = [];
      for (const sessionId of state.runningSessionIds ?? []) {
        checked += 1;
        const session = bridgeState.sessions[sessionId];
        if (!session) {
          staleSessionIds.push(sessionId);
          continue;
        }

        const needles = providerNeedlesForSession(session);
        if (needles.length === 0 || processNeedles.hasAny(needles)) {
          continue;
        }
        staleSessionIds.push(sessionId);
      }

      if (staleSessionIds.length === 0) {
        continue;
      }

      const now = new Date().toISOString();
      await this.pollingState.clearRunningSessions(botId, staleSessionIds, {
        username: bot.username,
        lastProviderFinishedAt: now,
        lastRecoveryAt: now,
        lastRecoveryReason: "stale running marker cleared; no matching provider process was found",
      });
      recovered += staleSessionIds.length;

      for (const sessionId of staleSessionIds) {
        const session = bridgeState.sessions[sessionId];
        const binding = findBinding(bridgeState, botId, sessionId);
        if (!session || !binding) {
          continue;
        }
        await this.notifyRecovered(bot, binding, session).catch((error) => {
          console.error(
            `[provider-recovery] failed to notify @${bot.username ?? bot.botId} for ${session.publicId}:`,
            summarizeError(error),
          );
        });
      }
    }

    return { checked, recovered };
  }

  private async notifyRecovered(bot: RecoveryBot, binding: ChatBinding, session: SessionRecord): Promise<void> {
    const noticeKey = [
      "stale-running-cleared",
      bot.botId,
      binding.chatId,
      session.sessionId,
      session.updatedAt,
    ].join(":");

    if (await this.wasNoticeDelivered(noticeKey)) {
      return;
    }

    const text = [
      `[RemoteAgent Recovery | ${session.publicId}]`,
      "Stale running state was cleared.",
      "",
      "Reason:",
      "RemoteAgent had a running marker for this session, but no matching Codex/Claude process was found.",
      "",
      "Action:",
      "- cleared the running marker",
      "- kept session, workspace, and history unchanged",
      "- the next message can start a fresh provider execution",
    ].join("\n");

    await sendTelegramPlainText(bot.token, binding.chatId, text);
    await this.markNoticeDelivered(noticeKey);
  }

  private async wasNoticeDelivered(key: string): Promise<boolean> {
    const notices = await this.readNoticeFile();
    return Boolean(notices.delivered[key]);
  }

  private async markNoticeDelivered(key: string): Promise<void> {
    const notices = await this.readNoticeFile();
    notices.updatedAt = new Date().toISOString();
    notices.delivered[key] = notices.updatedAt;
    await writeJsonAtomic(this.noticePath, notices);
  }

  private async readNoticeFile(): Promise<NoticeFile> {
    const raw = await fs.readFile(this.noticePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return { version: 1, updatedAt: "", delivered: {} };
    }
    try {
      const parsed = JSON.parse(raw) as NoticeFile;
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        delivered: parsed.delivered && typeof parsed.delivered === "object" ? parsed.delivered : {},
      };
    } catch {
      return { version: 1, updatedAt: "", delivered: {} };
    }
  }

  private async readBridgeState(): Promise<BridgeState> {
    const state = await this.readLegacyState();
    const sessionsDir = path.join(this.dataDir, "sessions");
    const channelsDir = path.join(this.dataDir, "channels", "telegram");

    const sessionDirs = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      const session = await readJson<SessionRecord>(path.join(sessionsDir, entry.name, "session.json"));
      if (session?.sessionId) {
        state.sessions[session.sessionId] = session;
      }
    }

    const botDirs = await fs.readdir(channelsDir, { withFileTypes: true }).catch(() => []);
    for (const botEntry of botDirs) {
      if (!botEntry.isDirectory()) {
        continue;
      }
      const botId = decodeURIComponent(botEntry.name);
      const bindingFiles = await fs.readdir(path.join(channelsDir, botEntry.name), { withFileTypes: true }).catch(() => []);
      for (const fileEntry of bindingFiles) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) {
          continue;
        }
        const binding = await readJson<ChatBinding>(path.join(channelsDir, botEntry.name, fileEntry.name));
        if (binding?.chatId && binding.sessionId) {
          binding.botId = binding.botId || botId;
          state.chats[`${binding.botId}:${binding.chatId}`] = binding;
        }
      }
    }

    return state;
  }

  private async readLegacyState(): Promise<BridgeState> {
    const raw = await fs.readFile(path.join(this.dataDir, "state.json"), "utf8").catch(() => "");
    if (!raw.trim()) {
      return { ...EMPTY_STATE, chats: {}, sessions: {}, telegramContacts: {}, settings: {} };
    }
    try {
      const parsed = JSON.parse(raw) as BridgeState;
      return {
        chats: parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {},
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
        telegramContacts: parsed.telegramContacts && typeof parsed.telegramContacts === "object" ? parsed.telegramContacts : {},
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
      };
    } catch {
      return { ...EMPTY_STATE, chats: {}, sessions: {}, telegramContacts: {}, settings: {} };
    }
  }
}

function providerNeedlesForSession(session: SessionRecord): string[] {
  return [
    `REMOTEAGENT_SESSION_ID=${session.sessionId}`,
    session.codex?.sessionId,
    session.claude?.sessionId,
  ].filter((value): value is string => Boolean(value && value.length >= 8));
}

function findBinding(state: BridgeState, botId: string, sessionId: string): ChatBinding | undefined {
  return Object.values(state.chats).find((binding) =>
    binding.botId === botId && binding.sessionId === sessionId,
  );
}

type ProcessNeedles = {
  hasAny(needles: string[]): boolean;
};

async function readProviderProcessNeedles(): Promise<ProcessNeedles> {
  const text = process.platform === "linux"
    ? await readLinuxProcessText()
    : await readPsProcessText();

  return {
    hasAny(needles: string[]): boolean {
      return needles.some((needle) => text.includes(needle));
    },
  };
}

async function readLinuxProcessText(): Promise<string> {
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const chunks: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const procDir = path.join("/proc", entry.name);
    const [cmdline, environ] = await Promise.all([
      fs.readFile(path.join(procDir, "cmdline"), "utf8").catch(() => ""),
      fs.readFile(path.join(procDir, "environ"), "utf8").catch(() => ""),
    ]);
    if (cmdline || environ) {
      chunks.push(cmdline.replace(/\0/g, " "), environ.replace(/\0/g, " "));
    }
  }
  return chunks.join("\n");
}

async function readPsProcessText(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]).catch(() => ({ stdout: "" }));
  return stdout;
}

async function sendTelegramPlainText(token: string, chatId: string, text: string): Promise<void> {
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
  });
  const { stdout } = await execFileAsync("curl", [
    "-sS",
    "-4",
    "--max-time",
    "15",
    "-H",
    "Content-Type: application/json",
    "-d",
    payload,
    `https://api.telegram.org/bot${token}/sendMessage`,
  ]);
  const parsed = JSON.parse(stdout) as { ok?: boolean; description?: string };
  if (!parsed.ok) {
    throw new Error(parsed.description || "sendMessage failed");
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]") : String(error);
}
