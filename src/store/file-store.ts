import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BridgeMode,
  BridgeState,
  ChatBinding,
  ChatSession,
  Provider,
  ProviderSession,
  SessionRecord,
} from "../types.js";

type LegacyChatMapping = {
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

  async getChatSession(chatId: string): Promise<ChatSession | undefined> {
    const state = await this.readState();
    return this.resolveChatSession(state, chatId);
  }

  async upsertProviderForChat(
    chatId: string,
    provider: Provider,
    session: Omit<ProviderSession, "provider">,
    workspace: string,
  ): Promise<ChatSession> {
    const state = await this.readState();
    const now = new Date().toISOString();
    const { binding, record } = this.ensureBoundSession(state, chatId, workspace, now);

    record.workspace = workspace;
    record[provider] = {
      provider,
      ...session,
    };
    record.updatedAt = now;
    binding.updatedAt = now;

    await this.writeState(state);
    return this.mustResolveChatSession(state, chatId);
  }

  async setModeForChat(chatId: string, mode: BridgeMode): Promise<ChatSession> {
    const state = await this.readState();
    const now = new Date().toISOString();
    const { binding, record } = this.ensureBoundSession(state, chatId, this.dataDir, now);

    record.mode = mode;
    record.updatedAt = now;
    binding.updatedAt = now;

    await this.writeState(state);
    return this.mustResolveChatSession(state, chatId);
  }

  async resetChat(chatId: string): Promise<void> {
    const state = await this.readState();
    delete state.chats[chatId];
    await this.writeState(state);
  }

  async appendLog(remoteSessionId: string, line: string): Promise<void> {
    const logFile = path.join(this.logsDir, `${remoteSessionId}.jsonl`);
    await fs.appendFile(logFile, `${line}\n`, "utf8");
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
      migrated.chats[chatId] = {
        chatId,
        sessionId,
        boundAt: now,
        updatedAt: now,
      };
    }

    return { state: migrated, migrated: true };
  }

  private resolveChatSession(state: BridgeState, chatId: string): ChatSession | undefined {
    const binding = state.chats[chatId];
    if (!binding) {
      return undefined;
    }

    const session = state.sessions[binding.sessionId];
    if (!session) {
      return undefined;
    }

    return {
      chatId,
      binding,
      session,
    };
  }

  private mustResolveChatSession(state: BridgeState, chatId: string): ChatSession {
    const result = this.resolveChatSession(state, chatId);
    if (!result) {
      throw new Error(`Chat binding was not found for chat ${chatId}.`);
    }

    return result;
  }

  private ensureBoundSession(
    state: BridgeState,
    chatId: string,
    workspace: string,
    now: string,
  ): { binding: ChatBinding; record: SessionRecord } {
    let binding = state.chats[chatId];
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
        chatId,
        sessionId,
        boundAt: now,
        updatedAt: now,
      };
      state.sessions[sessionId] = record;
      state.chats[chatId] = binding;
    }

    return { binding, record };
  }
}
