import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BridgeMode,
  BridgeState,
  ChatBinding,
  ChatSession,
  LogEntry,
  Provider,
  ProviderSession,
  SessionRecord,
} from "../types.js";

type LegacyChatMapping = {
  botId?: string;
  chatId: string;
  mode: BridgeMode;
  codex?: ProviderSession;
  claude?: ProviderSession;
  updatedAt: string;
};

type LegacyBridgeState = {
  chats: Record<string, LegacyChatMapping>;
};

const EMPTY_STATE: BridgeState = { chats: {}, sessions: {} };

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
      await this.readState();
    } catch {
      await this.writeState(EMPTY_STATE);
    }
  }

  async getChatSession(botId: string, chatId: string): Promise<ChatSession | undefined> {
    const state = await this.readState();
    return this.resolveChatSession(state, botId, chatId);
  }

  async listSessions(): Promise<SessionRecord[]> {
    const state = await this.readState();
    return Object.values(state.sessions).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const state = await this.readState();
    return state.sessions[sessionId];
  }

  async upsertProviderForChat(
    botId: string,
    chatId: string,
    provider: Provider,
    session: Omit<ProviderSession, "provider">,
    workspace: string,
  ): Promise<ChatSession> {
    const state = await this.readState();
    const now = new Date().toISOString();
    const { binding, record } = this.ensureBoundSession(state, botId, chatId, workspace, now);

    record.workspace = workspace;
    record[provider] = {
      provider,
      ...session,
    };
    record.updatedAt = now;
    binding.updatedAt = now;

    await this.writeState(state);
    return this.mustResolveChatSession(state, botId, chatId);
  }

  async upsertProviderForSession(
    sessionId: string,
    provider: Provider,
    session: Omit<ProviderSession, "provider">,
    workspace: string,
  ): Promise<SessionRecord> {
    const state = await this.readState();
    const record = state.sessions[sessionId];
    if (!record) {
      throw new Error(`Session was not found: ${sessionId}`);
    }

    record.workspace = workspace;
    record[provider] = {
      provider,
      ...session,
    };
    record.updatedAt = new Date().toISOString();

    await this.writeState(state);
    return record;
  }

  async setModeForChat(botId: string, chatId: string, mode: BridgeMode): Promise<ChatSession> {
    const state = await this.readState();
    const now = new Date().toISOString();
    const { binding, record } = this.ensureBoundSession(state, botId, chatId, this.dataDir, now);

    record.mode = mode;
    record.updatedAt = now;
    binding.updatedAt = now;

    await this.writeState(state);
    return this.mustResolveChatSession(state, botId, chatId);
  }

  async resetChat(botId: string, chatId: string): Promise<void> {
    const state = await this.readState();
    delete state.chats[this.chatKey(botId, chatId)];
    await this.writeState(state);
  }

  async appendLog(remoteSessionId: string, line: string): Promise<void> {
    const logFile = path.join(this.logsDir, `${remoteSessionId}.jsonl`);
    await fs.appendFile(logFile, `${line}\n`, "utf8");
  }

  async readLogs(remoteSessionId: string, limit = 200): Promise<LogEntry[]> {
    const logFile = path.join(this.logsDir, `${remoteSessionId}.jsonl`);
    const raw = await fs.readFile(logFile, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    });

    const entries: LogEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        continue;
      }
    }

    return entries.slice(Math.max(0, entries.length - limit));
  }

  private async readState(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const { state, migrated } = this.normalizeState(JSON.parse(raw) as BridgeState | LegacyBridgeState);
      if (migrated) {
        await this.writeState(state);
      }
      return state;
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

  private normalizeState(rawState: BridgeState | LegacyBridgeState): { state: BridgeState; migrated: boolean } {
    if ("sessions" in rawState) {
      const state = rawState as BridgeState;

      for (const session of Object.values(state.sessions)) {
        session.workspace = session.workspace || session.codex?.cwd || session.claude?.cwd || this.dataDir;
        session.createdAt = session.createdAt || session.updatedAt || new Date().toISOString();
        session.updatedAt = session.updatedAt || session.createdAt;

        for (const provider of ["codex", "claude"] as Provider[]) {
          const binding = session[provider];
          if (binding && !binding.cwd) {
            binding.cwd = session.workspace;
          }
        }
      }

      return { state, migrated: false };
    }

    const legacy = rawState as LegacyBridgeState;
    const migrated: BridgeState = { chats: {}, sessions: {} };

    for (const [chatId, mapping] of Object.entries(legacy.chats || {})) {
      const sessionId = randomUUID();
      const now = mapping.updatedAt || new Date().toISOString();
      const workspace = mapping.codex?.cwd || mapping.claude?.cwd || this.dataDir;

      migrated.sessions[sessionId] = {
        sessionId,
        mode: mapping.mode || this.defaultMode,
        workspace,
        codex: mapping.codex ? { ...mapping.codex, provider: "codex", cwd: mapping.codex.cwd || workspace } : undefined,
        claude: mapping.claude ? { ...mapping.claude, provider: "claude", cwd: mapping.claude.cwd || workspace } : undefined,
        createdAt: now,
        updatedAt: now,
      };
      migrated.chats[this.chatKey(mapping.botId, chatId)] = {
        botId: mapping.botId,
        chatId,
        sessionId,
        boundAt: now,
        updatedAt: now,
      };
    }

    return { state: migrated, migrated: true };
  }

  private resolveChatSession(state: BridgeState, botId: string, chatId: string): ChatSession | undefined {
    const binding = this.resolveBinding(state, botId, chatId);
    if (!binding) {
      return undefined;
    }

    const session = state.sessions[binding.sessionId];
    if (!session) {
      return undefined;
    }

    return {
      botId: binding.botId ?? botId,
      chatId,
      binding,
      session,
    };
  }

  private mustResolveChatSession(state: BridgeState, botId: string, chatId: string): ChatSession {
    const result = this.resolveChatSession(state, botId, chatId);
    if (!result) {
      throw new Error(`Chat binding was not found for bot ${botId} chat ${chatId}.`);
    }

    return result;
  }

  private ensureBoundSession(
    state: BridgeState,
    botId: string,
    chatId: string,
    workspace: string,
    now: string,
  ): { binding: ChatBinding; record: SessionRecord } {
    const exactKey = this.chatKey(botId, chatId);
    const legacyBinding = state.chats[chatId];
    let binding = state.chats[exactKey] ?? legacyBinding;
    let record = binding ? state.sessions[binding.sessionId] : undefined;

    if (!binding || !record) {
      const sessionId = randomUUID();
      record = {
        sessionId,
        mode: this.defaultMode,
        workspace,
        createdAt: now,
        updatedAt: now,
      };
      binding = {
        botId,
        chatId,
        sessionId,
        boundAt: now,
        updatedAt: now,
      };
      state.sessions[sessionId] = record;
      state.chats[exactKey] = binding;
      return { binding, record };
    }

    if (!state.chats[exactKey]) {
      binding = {
        ...binding,
        botId,
        chatId,
      };
      state.chats[exactKey] = binding;
    } else if (!binding.botId) {
      binding.botId = botId;
    }

    return { binding, record };
  }

  private resolveBinding(state: BridgeState, botId: string, chatId: string): ChatBinding | undefined {
    return state.chats[this.chatKey(botId, chatId)] ?? state.chats[chatId];
  }

  private chatKey(botId: string | undefined, chatId: string): string {
    return botId ? `${botId}:${chatId}` : chatId;
  }
}
