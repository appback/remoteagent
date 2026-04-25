import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: FileStore,
    private readonly adapters: Partial<Record<Provider, ProviderAdapter>>,
    private readonly defaultWorkspace: string,
    private readonly availableProviders: Provider[],
    private readonly preferredStartMode: BridgeMode,
  ) {}

  async createSession(botId: string, chatId: string, cwd?: string): Promise<ChatSession> {
    const provider = await this.resolveStartProvider();
    return this.startSession(botId, chatId, provider, cwd);
  }

  async switchSession(botId: string, chatId: string, sessionId: string): Promise<ChatSession> {
    const selector = sessionId.trim();
    if (!selector) {
      throw new Error("Session selector is required.");
    }

    const session = await this.resolveSessionSelector(selector);
    if (!session) {
      throw new Error(`Session was not found: ${selector}`);
    }

    return this.store.bindChatToSession(botId, chatId, session.sessionId);
  }

  async startSession(botId: string, chatId: string, provider: Provider, cwd?: string): Promise<ChatSession> {
    this.ensureConfigured(provider);

    const existing = await this.store.getChatSession(botId, chatId);
    const workspace = this.resolveWorkspace(existing?.session.workspace, cwd);
    await this.ensureWorkspaceExists(workspace);

    await this.store.createSessionForChat(botId, chatId, workspace, provider);
    const chatSession = await this.store.upsertProviderForChat(botId, chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: undefined,
      model: provider === "codex" ? "gpt-5.4" : "sonnet",
      lastUsedAt: undefined,
    }, workspace);
    await this.store.ensureDefaultStartMode(provider);
    return chatSession;
  }

  async attachPair(
    botId: string,
    chatId: string,
    provider: Provider,
    sessionId: string,
  ): Promise<ChatSession> {
    this.ensureConfigured(provider);

    const existing = await this.store.getChatSession(botId, chatId);
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }

    let workspace: string;
    if (provider === "codex") {
      const detectedWorkspace = await this.readCodexSessionWorkspace(normalizedSessionId);

      if (detectedWorkspace) {
        workspace = detectedWorkspace;
        await this.ensureWorkspaceExists(workspace);
      } else {
        workspace = this.resolveWorkspace(existing?.session[provider]?.cwd ?? existing?.session.workspace, undefined);
        await this.ensureWorkspaceExists(workspace);
        await this.verifyCodexAttachWorkspace(
          botId,
          chatId,
          normalizedSessionId,
          workspace,
          existing?.session.codex,
        );
      }
    } else {
      workspace = this.resolveWorkspace(existing?.session[provider]?.cwd ?? existing?.session.workspace, undefined);
      await this.ensureWorkspaceExists(workspace);
    }

    const chatSession = await this.store.upsertProviderForChat(botId, chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: normalizedSessionId,
      model: existing?.session[provider]?.model ?? (provider === "codex" ? "gpt-5.4" : "sonnet"),
      lastUsedAt: undefined,
    }, workspace);
    await this.store.ensureDefaultStartMode(provider);
    return chatSession;
  }

  async resolveStartProvider(requested?: string): Promise<Provider> {
    const normalized = requested?.trim().toLowerCase();
    if (normalized) {
      if (normalized !== "codex" && normalized !== "claude") {
        throw new Error("Provider must be codex or claude.");
      }

      const explicit = normalized as Provider;
      if (!this.isProviderAvailable(explicit)) {
        throw new Error(this.formatInstallGuidance(explicit));
      }
      return explicit;
    }

    const savedDefault = await this.store.getDefaultStartMode();
    const candidates = [savedDefault, this.preferredStartMode, ...this.availableProviders]
      .filter((value, index, items): value is Provider => Boolean(value) && items.indexOf(value) === index);

    const provider = candidates.find((item) => this.isProviderAvailable(item));
    if (!provider) {
      throw new Error(this.formatInstallGuidance());
    }

    return provider;
  }

  listAvailableProviders(): Provider[] {
    return [...this.availableProviders];
  }

  formatInstallGuidance(requested?: Provider): string {
    const available = this.listAvailableProviders();
    const availableLine = available.length > 0
      ? `Installed modes: ${available.join(", ")}`
      : "Installed modes: none";

    if (requested) {
      const nextStep = requested === "claude"
        ? "Install Claude Code on this machine and finish the CLI login, then run /start claude."
        : "Install Codex CLI on this machine, then run /start codex.";
      return [
        `${requested} is not installed on this machine yet.`,
        availableLine,
        nextStep,
      ].join("\n");
    }

    return [
      "No installed coding mode was found on this machine.",
      availableLine,
      "Install Codex CLI or Claude Code first, then run /start, /start codex, or /start claude.",
    ].join("\n");
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

    return this.withSessionLock(chatSession.session.sessionId, () => this.routeSession(chatSession.session, message, "telegram", botId, chatId));
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

    return this.withSessionLock(session.sessionId, () => this.routeSession(session, message, "pc-ui"));
  }

  formatStatus(chatSession: ChatSession | undefined): string {
    if (!chatSession) {
      return "No paired session yet. Use /start, /start codex, /start claude, or /attach ...";
    }

    const { session } = chatSession;
    const codex = session.codex
      ? this.describeProviderSession(session.codex)
      : "- codex: not paired";
    const claude = session.claude
      ? this.describeProviderSession(session.claude)
      : "- claude: not paired";

    return [
      `session: ${session.publicId}`,
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
      `session: ${session.publicId}`,
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
        return `${marker} ${index + 1}. [${session.publicId}] ${this.workspaceLabel(session.workspace)}\n   mode: ${session.mode}\n   updatedAt: ${session.updatedAt}`;
      });

    return [
      `Sessions (${Math.min(limit, sessions.length)}/${sessions.length})`,
      ...rows,
    ].join("\n");
  }

  private async resolveSessionSelector(selector: string): Promise<SessionRecord | undefined> {
    const sessions = await this.store.listSessions();
    const trimmed = selector.trim();

    if (/^\d+$/.test(trimmed)) {
      const index = Number.parseInt(trimmed, 10);
      if (index >= 1 && index <= sessions.length) {
        return sessions[index - 1];
      }
    }

    const normalized = trimmed.toUpperCase();
    return sessions.find((session) =>
      session.publicId.toUpperCase() === normalized || session.sessionId === trimmed,
    );
  }

  private resolveProviders(mode: BridgeMode): Provider[] {
    return [mode];
  }

  private async requireChat(botId: string, chatId: string): Promise<ChatSession> {
    const chatSession = await this.store.getChatSession(botId, chatId);
    if (!chatSession) {
      throw new Error("No paired session for this chat yet. Run `/start codex`, `/start claude`, or `/attach ...` first.");
    }

    return chatSession;
  }

  private ensurePaired(chatSession: ChatSession, provider: Provider): void {
    if (!chatSession.session[provider]?.cwd) {
      throw new Error(`This chat is not paired with ${provider}. Run \`/start ${provider}\` or \`/attach ${provider} <session_id>\`.`);
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
    if (!this.isProviderAvailable(provider)) {
      throw new Error(this.formatInstallGuidance(provider));
    }
  }

  private isProviderAvailable(provider: Provider): boolean {
    return this.availableProviders.includes(provider) && Boolean(this.adapters[provider]);
  }

  private async log(entry: LogEntry): Promise<void> {
    await this.store.appendLog(entry.remoteSessionId, JSON.stringify(entry));
  }

  private async withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.sessionLocks.set(sessionId, queued);

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === queued) {
        this.sessionLocks.delete(sessionId);
      }
    }
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
    const actualWorkspace =
      await this.readCodexSessionWorkspace(providerSessionId)
      ?? await this.probeCodexAttachWorkspace(
        botId,
        chatId,
        providerSessionId,
        requestedWorkspace,
        existingSession,
      );

    if (!actualWorkspace) {
      throw new Error("Attach blocked: could not verify the resumed Codex session working directory.");
    }

    if (!this.pathsMatch(actualWorkspace, requestedWorkspace)) {
      throw new Error(
        `Attach blocked: resumed Codex session workspace is '${actualWorkspace}', not requested '${requestedWorkspace}'.`,
      );
    }
  }

  private async readCodexSessionWorkspace(providerSessionId: string): Promise<string | undefined> {
    const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
    const sessionFile = await this.findCodexSessionFile(sessionsRoot, providerSessionId);
    if (!sessionFile) {
      return undefined;
    }

    const raw = await fs.readFile(sessionFile, "utf8").catch(() => undefined);
    if (!raw) {
      return undefined;
    }

    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) {
      return undefined;
    }

    try {
      const event = JSON.parse(firstLine) as {
        type?: string;
        payload?: { cwd?: unknown };
      };
      if (event.type === "session_meta" && typeof event.payload?.cwd === "string" && event.payload.cwd.trim()) {
        return event.payload.cwd.trim();
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private async findCodexSessionFile(root: string, providerSessionId: string): Promise<string | undefined> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findCodexSessionFile(entryPath, providerSessionId);
        if (nested) {
          return nested;
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(`${providerSessionId}.jsonl`)) {
        return entryPath;
      }
    }

    return undefined;
  }

  private async probeCodexAttachWorkspace(
    botId: string,
    chatId: string,
    providerSessionId: string,
    requestedWorkspace: string,
    existingSession?: ProviderSession,
  ): Promise<string | undefined> {
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

    return this.extractCodexCwd(probe.output);
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
      ? "attached"
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

  private workspaceLabel(workspace: string): string {
    const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || workspace;
  }

  private async ensureWorkspaceExists(cwd: string): Promise<void> {
    const stat = await fs.stat(cwd).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error(`Workspace path does not exist: ${cwd}`);
    }
  }
}
