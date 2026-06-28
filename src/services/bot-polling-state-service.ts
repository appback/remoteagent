import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type BotPollingState = {
  botId: string;
  username?: string;
  runningSessionIds?: string[];
  lastProviderStartedAt?: string;
  lastProviderFinishedAt?: string;
  lastUpdateAt?: string;
  lastMessageAt?: string;
  lastPollAt?: string;
  nextPollAt?: string;
  consecutiveFailures: number;
};

type BotPollingStateFile = {
  version: 1;
  updatedAt: string;
  bots: Record<string, BotPollingState>;
};

const DEFAULT_STATE: BotPollingStateFile = {
  version: 1,
  updatedAt: "",
  bots: {},
};

export class BotPollingStateService {
  private readonly filePath: string;
  private cache: BotPollingStateFile | undefined;
  private pendingWrite: NodeJS.Timeout | undefined;
  private writeInFlight = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "bot-polling-state.json");
  }

  async get(botId: string, username?: string): Promise<BotPollingState> {
    const state = await this.read();
    const current = state.bots[botId] ?? {
      botId,
      username,
      consecutiveFailures: 0,
    };
    if (username && current.username !== username) {
      current.username = username;
      state.bots[botId] = current;
      this.scheduleWrite();
    }
    return current;
  }

  async list(): Promise<Record<string, BotPollingState>> {
    return { ...(await this.read()).bots };
  }

  async markRunning(botId: string, sessionId?: string, username?: string): Promise<void> {
    const state = await this.read();
    const current = state.bots[botId] ?? {
      botId,
      username,
      consecutiveFailures: 0,
    };
    if (username) {
      current.username = username;
    }
    const sessions = new Set(current.runningSessionIds ?? []);
    sessions.add(sessionId || "__unknown__");
    current.runningSessionIds = [...sessions];
    current.lastProviderStartedAt = new Date().toISOString();
    state.bots[botId] = current;
    await this.writeNow();
  }

  async markIdle(botId: string, sessionId?: string, username?: string): Promise<void> {
    const state = await this.read();
    const current = state.bots[botId] ?? {
      botId,
      username,
      consecutiveFailures: 0,
    };
    if (username) {
      current.username = username;
    }
    const runningSessionIds = current.runningSessionIds ?? [];
    if (runningSessionIds.length > 0) {
      const key = sessionId || "__unknown__";
      current.runningSessionIds = runningSessionIds.filter((value) => value !== key);
    }
    if (!current.runningSessionIds || current.runningSessionIds.length === 0) {
      delete current.runningSessionIds;
      current.lastProviderFinishedAt = new Date().toISOString();
    }
    state.bots[botId] = current;
    await this.writeNow();
  }

  async recordPoll(botId: string, patch: Partial<Omit<BotPollingState, "botId">>): Promise<void> {
    const state = await this.read();
    const current = state.bots[botId] ?? {
      botId,
      consecutiveFailures: 0,
    };
    state.bots[botId] = {
      ...current,
      ...patch,
      botId,
    };
    this.scheduleWrite();
  }

  async prune(validBotIds: string[]): Promise<void> {
    const valid = new Set(validBotIds);
    const state = await this.read();
    let changed = false;
    for (const botId of Object.keys(state.bots)) {
      if (!valid.has(botId)) {
        delete state.bots[botId];
        changed = true;
      }
    }
    if (changed) {
      await this.writeNow();
    }
  }

  formatMode(state?: BotPollingState): string {
    return state?.runningSessionIds && state.runningSessionIds.length > 0 ? "running" : "idle";
  }

  async flush(): Promise<void> {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = undefined;
    }
    await this.writeNow();
  }

  private async read(): Promise<BotPollingStateFile> {
    if (this.cache) {
      return this.cache;
    }
    const raw = await fs.readFile(this.filePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      this.cache = { ...DEFAULT_STATE, bots: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as BotPollingStateFile;
      this.cache = {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        bots: parsed.bots && typeof parsed.bots === "object" ? parsed.bots : {},
      };
    } catch {
      this.cache = { ...DEFAULT_STATE, bots: {} };
    }
    return this.cache;
  }

  private scheduleWrite(): void {
    if (this.pendingWrite) {
      return;
    }
    this.pendingWrite = setTimeout(() => {
      this.pendingWrite = undefined;
      void this.writeNow().catch((error) => {
        console.error("Failed to write bot polling state:", error);
      });
    }, 1000);
    this.pendingWrite.unref();
  }

  private async writeNow(): Promise<void> {
    const state = await this.read();
    state.updatedAt = new Date().toISOString();
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    this.writeInFlight = this.writeInFlight.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await fs.rename(tmpPath, this.filePath);
    });
    await this.writeInFlight;
  }
}
