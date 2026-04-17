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
  SessionRecord,
} from "../types.js";
import { FileStore } from "../store/file-store.js";

export class BridgeService {
  constructor(
    private readonly store: FileStore,
    private readonly adapters: Partial<Record<Provider, ProviderAdapter>>,
    private readonly defaultWorkspace: string,
  ) {}

  async createSession(botId: string, chatId: string, cwd?: string): Promise<ChatSession> {
    const existing = await this.store.getChatSession(botId, chatId);
    const workspace = this.resolveWorkspace(existing?.session.workspace, cwd);
    await this.ensureWorkspaceExists(workspace);
    return this.store.createSessionForChat(botId, chatId, workspace, existing?.session.mode);
  }

  async switchSession(botId: string, chatId: string, sessionId: string): Promise<ChatSession> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }

    const session = await this.store.getSession(normalizedSessionId);
    if (!session) {
      throw new Error(`Session was not found: ${normalizedSessionId}`);
    }

    return this.store.bindChatToSession(botId, chatId, normalizedSessionId);
  }

  async startPair(botId: string, chatId: string, provider: Provider, cwd?: string): Promise<ChatSession> {
    const existing = await this.store.getChatSession(botId, chatId);
    const workspace = this.resolveWorkspace(existing?.session[provider]?.cwd ?? existing?.session.workspace, cwd);
    await this.ensureWorkspaceExists(workspace);

    return this.store.upsertProviderForChat(botId, chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: undefined,
      model: provider === "codex" ? "gpt-5.4" : "sonnet",
      lastUsedAt: undefined,
    }, workspace);
  }

  async attachPair(
    botId: string,
    chatId: string,
    provider: Provider,
    sessionId: string,
    cwd?: string,
  ): Promise<ChatSession> {
    const existing = await this.store.getChatSession(botId, chatId);
    const workspace = this.resolveWorkspace(existing?.session[provider]?.cwd ?? existing?.session.workspace, cwd);
    await this.ensureWorkspaceExists(workspace);

    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }

    if (provider === "codex") {
      await this.verifyCodexAttachWorkspace(
        botId,
        chatId,
        normalizedSessionId,
        workspace,
        existing?.session.codex,
      );
    }

    return this.store.upsertProviderForChat(botId, chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: normalizedSessionId,
      model: existing?.session[provider]?.model ?? (provider === "codex" ? "gpt-5.4" : "sonnet"),
      lastUsedAt: undefined,
    }, workspace);
  }

  async setMode(botId: string, chatId: string, mode: BridgeMode): Promise<ChatSession> {
    if (mode === "compare") {
      const chatSession = await this.requireChat(botId, chatId);
      this.ensurePaired(chatSession, "codex");
      this.ensurePaired(chatSession, "claude");
      this.ensureConfigured("codex");
      this.ensureConfigured("claude");
    }

    if (mode === "codex") {
      const chatSession = await this.requireChat(botId, chatId);
      this.ensurePaired(chatSession, "codex");
      this.ensureConfigured("codex");
    }

    if (mode === "claude") {
      const chatSession = await this.requireChat(botId, chatId);
      this.ensurePaired(chatSession, "claude");
      this.ensureConfigured("claude");
    }

    return this.store.setModeForChat(botId, chatId, mode);
  }

  async setCodexSandboxMode(botId: string, chatId: string, sandboxMode: CodexSandboxMode): Promise<ChatSession> {
    const chatSession = await this.requireChat(botId, chatId);
    this.ensurePaired(chatSession, "codex");

    const codex = chatSession.session.codex!;
    return this.store.upsertProviderForChat(botId, chatId, "codex", {
      ...codex,
      sandboxMode,
    }, chatSession.session.workspace);
  }

  async status(botId: string, chatId: string): Promise<ChatSession | undefined> {
    return this.store.getChatSession(botId, chatId);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.store.listSessions();
  }

  async sessionEvents(sessionId: string, limit?: number): Promise<LogEntry[]> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session was not found: ${sessionId}`);
    }

    return this.store.readLogs(sessionId, limit);
  }

  async logSystem(botId: string, chatId: string, text: string): Promise<void> {
    const chatSession = await this.store.getChatSession(botId, chatId);
    if (!chatSession) {
      return;
    }

    await this.log({
      timestamp: new Date().toISOString(),
      remoteSessionId: chatSession.session.sessionId,
      botId,
      chatId,
      provider: "system",
      direction: "system",
      text,
    });
  }

  async reset(botId: string, chatId: string): Promise<void> {
    const chatSession = await this.store.getChatSession(botId, chatId);
    if (chatSession) {
      await this.log({
        timestamp: new Date().toISOString(),
        remoteSessionId: chatSession.session.sessionId,
        botId,
        chatId,
        provider: "system",
        direction: "system",
        text: "Chat binding reset.",
      });
    }

    await this.store.resetChat(botId, chatId);
  }

  async routeMessage(botId: string, chatId: string, message: string): Promise<ProviderResponse[]> {
    const chatSession = await this.requireChat(botId, chatId);

    await this.log({
      timestamp: new Date().toISOString(),
      remoteSessionId: chatSession.session.sessionId,
      botId,
      chatId,
      provider: "telegram",
      direction: "in",
      text: message,
    });

    return this.routeSession(chatSession.session, message, "telegram", botId, chatId);
  }

  async routeSessionMessage(sessionId: string, message: string): Promise<ProviderResponse[]> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session was not found: ${sessionId}`);
    }

    await this.log({
      timestamp: new Date().toISOString(),
      remoteSessionId: session.sessionId,
      provider: "pc-ui",
      direction: "in",
      text: message,
    });

    return this.routeSession(session, message, "pc-ui");
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
      `bot: ${chatSession.botId ?? chatSession.binding.botId ?? "unknown"}`,
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

  formatCurrentSession(chatSession: ChatSession | undefined): string {
    if (!chatSession) {
      return "No active session is bound to this chat.";
    }

    const { session } = chatSession;
    return [
      `session: ${session.sessionId}`,
      `bot: ${chatSession.botId ?? chatSession.binding.botId ?? "unknown"}`,
      `chat: ${chatSession.chatId}`,
      `mode: ${session.mode}`,
      `workspace: ${session.workspace}`,
      `updatedAt: ${session.updatedAt}`,
    ].join("\n");
  }

  formatSessionList(sessions: SessionRecord[], currentSessionId?: string, limit = 10): string {
    if (sessions.length === 0) {
      return "No sessions found.";
    }

    const rows = sessions
      .slice(0, limit)
      .map((session, index) => {
        const marker = session.sessionId === currentSessionId ? "*" : " ";
        return `${marker} ${index + 1}. ${session.sessionId}\n   mode: ${session.mode}\n   workspace: ${session.workspace}\n   updatedAt: ${session.updatedAt}`;
      });

    return [
      `Sessions (${Math.min(limit, sessions.length)}/${sessions.length})`,
      ...rows,
    ].join("\n");
  }

  private resolveProviders(mode: BridgeMode): Provider[] {
    if (mode === "compare") {
      return ["codex", "claude"];
    }

    return [mode];
  }

  private async requireChat(botId: string, chatId: string): Promise<ChatSession> {
    const chatSession = await this.store.getChatSession(botId, chatId);
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

  private ensureProviderSession(session: SessionRecord, provider: Provider): ProviderSession {
    const providerSession = session[provider];
    if (!providerSession?.cwd) {
      throw new Error(`Session ${session.sessionId} is not paired with ${provider}.`);
    }

    return providerSession;
  }

  private ensureConfigured(provider: Provider): void {
    if (!this.adapters[provider]) {
      throw new Error(`${provider} adapter is not configured. Check the install and environment settings.`);
    }
  }

  private async log(entry: LogEntry): Promise<void> {
    await this.store.appendLog(entry.remoteSessionId, JSON.stringify(entry));
  }

  private async routeSession(
    session: SessionRecord,
    message: string,
    requestSource: string,
    botId?: string,
    chatId?: string,
  ): Promise<ProviderResponse[]> {
    const responses: ProviderResponse[] = [];
    const providers = this.resolveProviders(session.mode);

    for (const provider of providers) {
      const providerSession = this.ensureProviderSession(session, provider);
      this.ensureConfigured(provider);

      const response = await this.adapters[provider]!.send({
        botId,
        chatId: chatId ?? requestSource,
        remoteSessionId: session.sessionId,
        cwd: providerSession.cwd,
        sessionId: providerSession.sessionId,
        message,
        model: providerSession.model,
        sandboxMode: providerSession.sandboxMode,
      });

      const updatedProviderSession = {
        ...providerSession,
        cwd: response.cwd,
        sessionId: response.sessionId,
        lastUsedAt: new Date().toISOString(),
      };

      if (chatId) {
        await this.store.upsertProviderForChat(botId ?? "telegram", chatId, provider, updatedProviderSession, session.workspace);
      } else {
        await this.store.upsertProviderForSession(
          session.sessionId,
          provider,
          updatedProviderSession,
          session.workspace,
        );
      }
      session[provider] = updatedProviderSession;

      await this.log({
        timestamp: new Date().toISOString(),
        remoteSessionId: session.sessionId,
        botId,
        chatId,
        provider,
        direction: "out",
        sessionId: response.sessionId,
        text: response.output,
      });

      responses.push(response);
    }

    return responses;
  }

  private async verifyCodexAttachWorkspace(
    botId: string,
    chatId: string,
    providerSessionId: string,
    requestedWorkspace: string,
    existingSession?: ProviderSession,
  ): Promise<void> {
    this.ensureConfigured("codex");

    const probe = await this.adapters.codex!.send({
      botId,
      chatId,
      remoteSessionId: existingSession?.sessionId ?? providerSessionId,
      cwd: requestedWorkspace,
      sessionId: providerSessionId,
      model: existingSession?.model,
      sandboxMode: existingSession?.sandboxMode,
      message: [
        "Safety check for workspace attach.",
        "Reply with JSON only.",
        "{\"cwd\":\"<current working directory>\"}",
      ].join("\n"),
    });

    const actualWorkspace = this.extractCodexCwd(probe.output);
    if (!actualWorkspace) {
      throw new Error("Attach blocked: could not verify the resumed Codex session working directory.");
    }

    if (!this.pathsMatch(actualWorkspace, requestedWorkspace)) {
      throw new Error(
        `Attach blocked: resumed Codex session workspace is '${actualWorkspace}', not requested '${requestedWorkspace}'.`,
      );
    }
  }

  private extractCodexCwd(output: string): string | undefined {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { cwd?: unknown };
        if (typeof parsed.cwd === "string" && parsed.cwd.trim()) {
          return parsed.cwd.trim();
        }
      } catch {
        // Fall back to line-based parsing below.
      }
    }

    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("cwd:")) {
        return trimmed.slice(4).trim().replace(/^["'`]+|["'`]+$/g, "");
      }
    }

    return undefined;
  }

  private pathsMatch(left: string, right: string): boolean {
    return this.normalizeComparablePath(left) === this.normalizeComparablePath(right);
  }

  private normalizeComparablePath(value: string): string {
    const trimmed = value.trim().replace(/^["'`]+|["'`]+$/g, "");
    const slashed = trimmed.replace(/\//g, "\\");
    const lower = slashed.toLowerCase();

    const wslMatch = lower.match(/^\\\\wsl\.localhost\\([^\\]+)\\(.+)$/);
    if (wslMatch) {
      return `/${wslMatch[2].replace(/\\/g, "/")}`;
    }

    const mntMatch = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
    if (mntMatch) {
      return `${mntMatch[1].toLowerCase()}:\\${mntMatch[2].replace(/\//g, "\\").toLowerCase()}`;
    }

    if (/^[a-zA-Z]:\\/.test(trimmed)) {
      return `${trimmed[0].toLowerCase()}:${trimmed.slice(2).replace(/\//g, "\\").toLowerCase()}`;
    }

    if (trimmed.startsWith("/")) {
      return trimmed.replace(/\\/g, "/").toLowerCase();
    }

    return lower;
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
