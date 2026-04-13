import fs from "node:fs/promises";
import path from "node:path";
import type { BridgeMode, BridgeState, ChatMapping, Provider } from "../types.js";

const EMPTY_STATE: BridgeState = { chats: {} };

export class FileStore {
  private readonly stateFile: string;
  private readonly logsDir: string;

  constructor(private readonly dataDir: string, private readonly defaultMode: BridgeMode) {
    this.stateFile = path.join(dataDir, "state.json");
    this.logsDir = path.join(dataDir, "logs");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.logsDir, { recursive: true });
    try {
      await fs.access(this.stateFile);
    } catch {
      await this.writeState(EMPTY_STATE);
    }
  }

  async getChat(chatId: string): Promise<ChatMapping | undefined> {
    const state = await this.readState();
    return state.chats[chatId];
  }

  async upsertProvider(chatId: string, provider: Provider, sessionId: string): Promise<ChatMapping> {
    const state = await this.readState();
    const now = new Date().toISOString();
    const current = state.chats[chatId] ?? {
      chatId,
      mode: this.defaultMode,
      updatedAt: now,
    };

    current[provider] = {
      provider,
      sessionId,
      pairedAt: now,
    };
    current.updatedAt = now;
    state.chats[chatId] = current;

    await this.writeState(state);
    return current;
  }

  async setMode(chatId: string, mode: BridgeMode): Promise<ChatMapping> {
    const state = await this.readState();
    const now = new Date().toISOString();
    const current = state.chats[chatId] ?? {
      chatId,
      mode,
      updatedAt: now,
    };

    current.mode = mode;
    current.updatedAt = now;
    state.chats[chatId] = current;

    await this.writeState(state);
    return current;
  }

  async resetChat(chatId: string): Promise<void> {
    const state = await this.readState();
    delete state.chats[chatId];
    await this.writeState(state);
  }

  async appendLog(chatId: string, line: string): Promise<void> {
    const logFile = path.join(this.logsDir, `${chatId}.jsonl`);
    await fs.appendFile(logFile, `${line}\n`, "utf8");
  }

  private async readState(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      return JSON.parse(raw) as BridgeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return EMPTY_STATE;
      }
      throw error;
    }
  }

  private async writeState(state: BridgeState): Promise<void> {
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
  }
}
