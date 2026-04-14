import fs from "node:fs/promises";
import type { ProviderAdapter } from "../adapters/provider-adapter.js";
import type {
  BridgeMode,
  ChatSession,
  CodexSandboxMode,
  LogEntry,
  Provider,
  ProviderResponse,
  ProviderSession,
} from "../types.js";
import { FileStore } from "../store/file-store.js";

export class BridgeService {
  constructor(
    private readonly store: FileStore,
    private readonly adapters: Partial<Record<Provider, ProviderAdapter>>,
    private readonly defaultWorkspace: string,
  ) {}

  async startPair(chatId: string, provider: Provider, cwd?: string): Promise<ChatSession> {
    const existing = await this.store.getChatSession(chatId);
    const workspace = this.resolveWorkspace(existing?.session[provider]?.cwd ?? existing?.session.workspace, cwd);
    await this.ensureWorkspaceExists(workspace);

    return this.store.upsertProviderForChat(chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: undefined,
      model: provider === "codex" ? "gpt-5.4" : "sonnet",
      lastUsedAt: undefined,
    }, workspace);
  }

  async attachPair(
    chatId: string,
    provider: Provider,
    sessionId: string,
    cwd?: string,
  ): Promise<ChatSession> {
    const existing = await this.store.getChatSession(chatId);
    const workspace = this.resolveWorkspace(existing?.session[provider]?.cwd ?? existing?.session.workspace, cwd);
    await this.ensureWorkspaceExists(workspace);

    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }

    return this.store.upsertProviderForChat(chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: normalizedSessionId,
      model: existing?.session[provider]?.model ?? (provider === "codex" ? "gpt-5.4" : "sonnet"),
      lastUsedAt: undefined,
    }, workspace);
  }

  async setMode(chatId: string, mode: BridgeMode): Promise<ChatSession> {
    if (mode === "compare") {
      const chatSession = await this.requireChat(chatId);
      this.ensurePaired(chatSession, "codex");
      this.ensurePaired(chatSession, "claude");
      this.ensureConfigured("codex");
      this.ensureConfigured("claude");
    }

    if (mode === "codex") {
      const chatSession = await this.requireChat(chatId);
      this.ensurePaired(chatSession, "codex");
      this.ensureConfigured("codex");
    }

    if (mode === "claude") {
      const chatSession = await this.requireChat(chatId);
      this.ensurePaired(chatSession, "claude");
      this.ensureConfigured("claude");
    }

    return this.store.setModeForChat(chatId, mode);
  }

  async setCodexSandboxMode(chatId: string, sandboxMode: CodexSandboxMode): Promise<ChatSession> {
    const chatSession = await this.requireChat(chatId);
    this.ensurePaired(chatSession, "codex");

    const codex = chatSession.session.codex!;
    return this.store.upsertProviderForChat(chatId, "codex", {
      ...codex,
      sandboxMode,
    }, chatSession.session.workspace);
  }

  async status(chatId: string): Promise<ChatSession | undefined> {
    return this.store.getChatSession(chatId);
  }

  async reset(chatId: string): Promise<void> {
    const chatSession = await this.store.getChatSession(chatId);
    if (chatSession) {
      await this.log({
        timestamp: new Date().toISOString(),
        remoteSessionId: chatSession.session.sessionId,
        chatId,
        provider: "system",
        direction: "system",
        text: "Chat binding reset.",
      });
    }

    await this.store.resetChat(chatId);
  }

  async routeMessage(chatId: string, message: string): Promise<ProviderResponse[]> {
    const chatSession = await this.requireChat(chatId);
    const remoteSessionId = chatSession.session.sessionId;

    await this.log({
      timestamp: new Date().toISOString(),
      remoteSessionId,
      chatId,
      provider: "telegram",
      direction: "in",
      text: message,
    });

    const providers = this.resolveProviders(chatSession.session.mode);
    const responses = await Promise.all(
      providers.map(async (provider) => {
        this.ensurePaired(chatSession, provider);
        this.ensureConfigured(provider);
        const providerSession = chatSession.session[provider];
        const response = await this.adapters[provider]!.send({
          chatId,
          remoteSessionId,
          cwd: providerSession!.cwd,
          sessionId: providerSession!.sessionId,
          message,
          model: providerSession!.model,
          sandboxMode: providerSession!.sandboxMode,
        });

        await this.store.upsertProviderForChat(chatId, provider, {
          ...providerSession!,
          cwd: response.cwd,
          sessionId: response.sessionId,
          lastUsedAt: new Date().toISOString(),
        }, chatSession.session.workspace);

        await this.log({
          timestamp: new Date().toISOString(),
          remoteSessionId,
          chatId,
          provider,
          direction: "out",
          sessionId: response.sessionId,
          text: response.output,
        });

        return response;
      }),
    );

    return responses;
  }

  formatStatus(chatSession: ChatSession | undefined): string {
    if (!chatSession) {
      return "No paired session yet. Use `/startpair codex`, `/startpair claude`, or `/attach ...`.";
    }

    const { session } = chatSession;
    const codex = session.codex
      ? this.describeProviderSession(session.codex)
      : "- codex: not paired";
    const claude = session.claude
      ? this.describeProviderSession(session.claude)
      : "- claude: not paired";

    return [
      `remoteSession: ${session.sessionId}`,
      `chat: ${chatSession.chatId}`,
      `mode: ${session.mode}`,
      `workspace: ${session.workspace}`,
      codex,
      claude,
      `createdAt: ${session.createdAt}`,
      `updatedAt: ${session.updatedAt}`,
    ].join("\n");
  }

  formatResponses(responses: ProviderResponse[]): string[] {
    return responses.map((response) => {
      const header = `[${response.provider.toUpperCase()} | ${response.sessionId}]`;
      return `${header}\n${response.output}`;
    });
  }

  private resolveProviders(mode: BridgeMode): Provider[] {
    if (mode === "compare") {
      return ["codex", "claude"];
    }

    return [mode];
  }

  private async requireChat(chatId: string): Promise<ChatSession> {
    const chatSession = await this.store.getChatSession(chatId);
    if (!chatSession) {
      throw new Error("No paired session for this chat yet. Run `/startpair codex`, `/startpair claude`, or `/attach ...` first.");
    }

    return chatSession;
  }

  private ensurePaired(chatSession: ChatSession, provider: Provider): void {
    if (!chatSession.session[provider]?.cwd) {
      throw new Error(`This chat is not paired with ${provider}. Run \`/startpair ${provider}\` or \`/attach ${provider} <session_id>\`.`);
    }
  }

  private ensureConfigured(provider: Provider): void {
    if (!this.adapters[provider]) {
      throw new Error(`${provider} adapter is not configured. Check the install and environment settings.`);
    }
  }

  private async log(entry: LogEntry): Promise<void> {
    await this.store.appendLog(entry.remoteSessionId, JSON.stringify(entry));
  }

  private describeProviderSession(session: ProviderSession): string {
    const state = session.sessionId
      ? `attached ${session.sessionId}`
      : "pending-first-run";
    const details = [`- ${session.provider}: ${state} @ ${session.cwd}`];

    if (session.provider === "codex" && session.sandboxMode) {
      details.push(`  sandbox: ${session.sandboxMode}`);
    }

    if (session.lastUsedAt) {
      details.push(`  lastUsedAt: ${session.lastUsedAt}`);
    }

    return details.join("\n");
  }

  private resolveWorkspace(current: string | undefined, next: string | undefined): string {
    return next?.trim() || current || this.defaultWorkspace;
  }

  private async ensureWorkspaceExists(cwd: string): Promise<void> {
    const stat = await fs.stat(cwd).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error(`Workspace path does not exist: ${cwd}`);
    }
  }
}
