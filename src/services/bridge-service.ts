import fs from "node:fs/promises";
import type { ProviderAdapter } from "../adapters/provider-adapter.js";
import type {
  BridgeMode,
  ChatMapping,
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

  async startPair(chatId: string, provider: Provider, cwd?: string): Promise<ChatMapping> {
    const existing = await this.store.getChat(chatId);
    const workspace = this.resolveWorkspace(existing?.[provider]?.cwd, cwd);
    await this.ensureWorkspaceExists(workspace);

    return this.store.upsertProvider(chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: undefined,
      model: provider === "codex" ? "gpt-5.4" : "sonnet",
      lastUsedAt: undefined,
    });
  }

  async attachPair(
    chatId: string,
    provider: Provider,
    sessionId: string,
    cwd?: string,
  ): Promise<ChatMapping> {
    const existing = await this.store.getChat(chatId);
    const workspace = this.resolveWorkspace(existing?.[provider]?.cwd, cwd);
    await this.ensureWorkspaceExists(workspace);

    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }

    return this.store.upsertProvider(chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      sessionId: normalizedSessionId,
      model: existing?.[provider]?.model ?? (provider === "codex" ? "gpt-5.4" : "sonnet"),
      lastUsedAt: undefined,
    });
  }

  async setMode(chatId: string, mode: BridgeMode): Promise<ChatMapping> {
    if (mode === "compare") {
      const mapping = await this.requireChat(chatId);
      this.ensurePaired(mapping, "codex");
      this.ensurePaired(mapping, "claude");
      this.ensureConfigured("codex");
      this.ensureConfigured("claude");
    }

    if (mode === "codex") {
      const mapping = await this.requireChat(chatId);
      this.ensurePaired(mapping, "codex");
      this.ensureConfigured("codex");
    }

    if (mode === "claude") {
      const mapping = await this.requireChat(chatId);
      this.ensurePaired(mapping, "claude");
      this.ensureConfigured("claude");
    }

    return this.store.setMode(chatId, mode);
  }

  async status(chatId: string): Promise<ChatMapping | undefined> {
    return this.store.getChat(chatId);
  }

  async reset(chatId: string): Promise<void> {
    await this.store.resetChat(chatId);
  }

  async routeMessage(chatId: string, message: string): Promise<ProviderResponse[]> {
    const mapping = await this.requireChat(chatId);
    await this.log({
      timestamp: new Date().toISOString(),
      chatId,
      provider: "telegram",
      direction: "in",
      text: message,
    });

    const providers = this.resolveProviders(mapping.mode);
    const responses = await Promise.all(
      providers.map(async (provider) => {
        this.ensurePaired(mapping, provider);
        this.ensureConfigured(provider);
        const session = mapping[provider];
        const response = await this.adapters[provider]!.send({
          chatId,
          cwd: session!.cwd,
          sessionId: session!.sessionId,
          message,
          model: session!.model,
        });

        await this.store.upsertProvider(chatId, provider, {
          ...session!,
          cwd: response.cwd,
          sessionId: response.sessionId,
          lastUsedAt: new Date().toISOString(),
        });

        await this.log({
          timestamp: new Date().toISOString(),
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

  formatStatus(mapping: ChatMapping | undefined): string {
    if (!mapping) {
      return "No paired session yet. Use `/startpair codex`, `/startpair claude`, or `/attach ...`.";
    }

    const codex = mapping.codex
      ? this.describeSession(mapping.codex)
      : "- codex: not paired";
    const claude = mapping.claude
      ? this.describeSession(mapping.claude)
      : "- claude: not paired";

    return [
      `chat: ${mapping.chatId}`,
      `mode: ${mapping.mode}`,
      codex,
      claude,
      `updatedAt: ${mapping.updatedAt}`,
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

  private async requireChat(chatId: string): Promise<ChatMapping> {
    const mapping = await this.store.getChat(chatId);
    if (!mapping) {
      throw new Error("No paired session for this chat yet. Run `/startpair codex`, `/startpair claude`, or `/attach ...` first.");
    }

    return mapping;
  }

  private ensurePaired(mapping: ChatMapping, provider: Provider): void {
    if (!mapping[provider]?.cwd) {
      throw new Error(`This chat is not paired with ${provider}. Run \`/startpair ${provider}\` or \`/attach ${provider} <session_id>\`.`);
    }
  }

  private ensureConfigured(provider: Provider): void {
    if (!this.adapters[provider]) {
      throw new Error(`${provider} adapter is not configured. Check the install and environment settings.`);
    }
  }

  private async log(entry: LogEntry): Promise<void> {
    await this.store.appendLog(entry.chatId, JSON.stringify(entry));
  }

  private describeSession(session: ProviderSession): string {
    const state = session.sessionId
      ? `attached ${session.sessionId}`
      : "pending-first-run";
    const details = [`- ${session.provider}: ${state} @ ${session.cwd}`];

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
