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
  private readonly legacyLogsDir: string;
  private readonly sessionsDir: string;
  private readonly telegramChannelsDir: string;

  constructor(private readonly dataDir: string, private readonly defaultMode: BridgeMode) {
    this.stateFile = path.join(dataDir, "state.json");
    this.legacyLogsDir = path.join(dataDir, "logs");
    this.sessionsDir = path.join(dataDir, "sessions");
    this.telegramChannelsDir = path.join(dataDir, "channels", "telegram");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.legacyLogsDir, { recursive: true });
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(this.telegramChannelsDir, { recursive: true });

    let state = await this.readState();
    if (Object.keys(state.chats).length === 0) {
      const recovered = await this.recoverBindingsFromLogs(state);
      if (Object.keys(recovered.chats).length > 0) {
        state = recovered;
      }
    }
    await this.writeState(state);
  }

  async getChatSession(botId: string, chatId: string): Promise<ChatSession | undefined> {
    const state = await this.readState();
    const migrated = this.materializeBindingForBot(state, botId, chatId);
    if (migrated) {
      await this.writeState(state);
    }
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
    delete state.chats[chatId];
    await this.writeState(state);
    await fs.rm(this.channelFilePath(botId, chatId), { force: true }).catch(() => undefined);
  }

  async appendLog(remoteSessionId: string, line: string): Promise<void> {
    const eventFile = this.sessionEventsPath(remoteSessionId);
    await fs.mkdir(path.dirname(eventFile), { recursive: true });
    await fs.appendFile(eventFile, `${line}\n`, "utf8");

    const legacyLogFile = path.join(this.legacyLogsDir, `${remoteSessionId}.jsonl`);
    await fs.appendFile(legacyLogFile, `${line}\n`, "utf8");
  }

  async readLogs(remoteSessionId: string, limit = 200): Promise<LogEntry[]> {
    const eventFile = this.sessionEventsPath(remoteSessionId);
    const primary = await this.readLogFile(eventFile);
    if (primary.length > 0) {
      return primary.slice(Math.max(0, primary.length - limit));
    }

    const legacyLogFile = path.join(this.legacyLogsDir, `${remoteSessionId}.jsonl`);
    const legacy = await this.readLogFile(legacyLogFile);
    return legacy.slice(Math.max(0, legacy.length - limit));
  }

  private async readState(): Promise<BridgeState> {
    const directoryState = await this.readStateFromDirectories();
    const legacyState = await this.readLegacyState();
    return this.mergeStates(directoryState, legacyState);
  }

  private async writeState(state: BridgeState): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(this.telegramChannelsDir, { recursive: true });

    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    await this.writeSessions(state.sessions);
    await this.writeChannelBindings(state.chats);
  }

  private async readStateFromDirectories(): Promise<BridgeState> {
    const state: BridgeState = { chats: {}, sessions: {} };

    const sessionDirs = await fs.readdir(this.sessionsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sessionFile = path.join(this.sessionsDir, entry.name, "session.json");
      const session = await this.readJsonFile<SessionRecord>(sessionFile);
      if (!session) {
        continue;
      }

      state.sessions[session.sessionId] = this.normalizeSession(session);
    }

    const botDirs = await fs.readdir(this.telegramChannelsDir, { withFileTypes: true }).catch(() => []);
    for (const botEntry of botDirs) {
      if (!botEntry.isDirectory()) {
        continue;
      }

      const botId = decodeURIComponent(botEntry.name);
      const botDir = path.join(this.telegramChannelsDir, botEntry.name);
      const bindingFiles = await fs.readdir(botDir, { withFileTypes: true }).catch(() => []);

      for (const fileEntry of bindingFiles) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) {
          continue;
        }

        const binding = await this.readJsonFile<ChatBinding>(path.join(botDir, fileEntry.name));
        if (!binding?.chatId || !binding.sessionId) {
          continue;
        }

        binding.botId = binding.botId || botId;
        state.chats[this.chatKey(binding.botId, binding.chatId)] = binding;
      }
    }

    return state;
  }

  private async readLegacyState(): Promise<BridgeState> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const { state } = this.normalizeState(JSON.parse(raw) as BridgeState | LegacyBridgeState);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return EMPTY_STATE;
      }
      throw error;
    }
  }

  private async writeSessions(sessions: Record<string, SessionRecord>): Promise<void> {
    for (const session of Object.values(sessions)) {
      const normalized = this.normalizeSession(session);
      const sessionDir = this.sessionDirPath(session.sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionDir, "session.json"),
        JSON.stringify(normalized, null, 2),
        "utf8",
      );
    }
  }

  private async writeChannelBindings(chats: Record<string, ChatBinding>): Promise<void> {
    const desiredFiles = new Set<string>();

    for (const binding of Object.values(chats)) {
      if (!binding.botId) {
        continue;
      }

      const filePath = this.channelFilePath(binding.botId, binding.chatId);
      desiredFiles.add(filePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(binding, null, 2), "utf8");
    }

    const existingFiles = await this.listChannelFiles();
    for (const filePath of existingFiles) {
      if (!desiredFiles.has(filePath)) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async listChannelFiles(): Promise<string[]> {
    const files: string[] = [];
    const botDirs = await fs.readdir(this.telegramChannelsDir, { withFileTypes: true }).catch(() => []);

    for (const botEntry of botDirs) {
      if (!botEntry.isDirectory()) {
        continue;
      }

      const botDir = path.join(this.telegramChannelsDir, botEntry.name);
      const entries = await fs.readdir(botDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          files.push(path.join(botDir, entry.name));
        }
      }
    }

    return files;
  }

  private async readLogFile(filePath: string): Promise<LogEntry[]> {
    const raw = await fs.readFile(filePath, "utf8").catch((error) => {
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

    return entries;
  }

  private async readJsonFile<T>(filePath: string): Promise<T | undefined> {
    const raw = await fs.readFile(filePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    });

    if (!raw) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private normalizeState(rawState: BridgeState | LegacyBridgeState): { state: BridgeState; migrated: boolean } {
    if ("sessions" in rawState) {
      const state = rawState as BridgeState;

      for (const session of Object.values(state.sessions)) {
        this.normalizeSession(session);
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

  private mergeStates(primary: BridgeState, fallback: BridgeState): BridgeState {
    const state: BridgeState = {
      chats: { ...fallback.chats, ...primary.chats },
      sessions: { ...fallback.sessions, ...primary.sessions },
    };

    for (const session of Object.values(state.sessions)) {
      this.normalizeSession(session);
    }

    return state;
  }

  private async recoverBindingsFromLogs(state: BridgeState): Promise<BridgeState> {
    const latestByChat = new Map<string, { sessionId: string; timestamp: string }>();

    for (const session of Object.values(state.sessions)) {
      const eventFile = this.sessionEventsPath(session.sessionId);
      const primaryEntries = await this.readLogFile(eventFile);
      const entries = primaryEntries.length > 0
        ? primaryEntries
        : await this.readLogFile(path.join(this.legacyLogsDir, `${session.sessionId}.jsonl`));

      for (const entry of entries) {
        if (!entry.chatId) {
          continue;
        }

        const current = latestByChat.get(entry.chatId);
        if (!current || current.timestamp.localeCompare(entry.timestamp) < 0) {
          latestByChat.set(entry.chatId, {
            sessionId: session.sessionId,
            timestamp: entry.timestamp,
          });
        }
      }
    }

    for (const [chatId, recovered] of latestByChat.entries()) {
      if (state.chats[chatId]) {
        continue;
      }

      state.chats[chatId] = {
        chatId,
        sessionId: recovered.sessionId,
        boundAt: recovered.timestamp,
        updatedAt: recovered.timestamp,
      };
    }

    return state;
  }

  private normalizeSession(session: SessionRecord): SessionRecord {
    session.workspace = session.workspace || session.codex?.cwd || session.claude?.cwd || this.dataDir;
    session.createdAt = session.createdAt || session.updatedAt || new Date().toISOString();
    session.updatedAt = session.updatedAt || session.createdAt;

    for (const provider of ["codex", "claude"] as Provider[]) {
      const binding = session[provider];
      if (binding && !binding.cwd) {
        binding.cwd = session.workspace;
      }
    }

    return session;
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
    const migrated = this.materializeBindingForBot(state, botId, chatId);
    let binding = state.chats[exactKey] ?? (migrated ? state.chats[exactKey] : undefined);
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
    return state.chats[this.chatKey(botId, chatId)];
  }

  private materializeBindingForBot(state: BridgeState, botId: string, chatId: string): boolean {
    const exactKey = this.chatKey(botId, chatId);
    if (state.chats[exactKey]) {
      return false;
    }

    const legacyBinding = state.chats[chatId];
    if (!legacyBinding) {
      return false;
    }

    state.chats[exactKey] = {
      ...legacyBinding,
      botId,
      chatId,
    };
    delete state.chats[chatId];
    return true;
  }

  private sessionDirPath(sessionId: string): string {
    return path.join(this.sessionsDir, encodeURIComponent(sessionId));
  }

  private sessionEventsPath(sessionId: string): string {
    return path.join(this.sessionDirPath(sessionId), "events.jsonl");
  }

  private channelFilePath(botId: string, chatId: string): string {
    return path.join(
      this.telegramChannelsDir,
      encodeURIComponent(botId),
      `${encodeURIComponent(chatId)}.json`,
    );
  }

  private chatKey(botId: string | undefined, chatId: string): string {
    return botId ? `${botId}:${chatId}` : chatId;
  }
}
