import fs from "node:fs/promises";
import type { ProviderAdapter } from "../adapters/provider-adapter.js";
import type {
  BridgeMode,
  ChatMapping,
  LogEntry,
  Provider,
  ProviderSession,
  ProviderResponse,
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
    const workspace = cwd?.trim() || existing?.[provider]?.cwd || this.defaultWorkspace;
    await this.ensureWorkspaceExists(workspace);

    if (existing?.[provider] && existing[provider]!.cwd === workspace) {
      return existing;
    }

    return this.store.upsertProvider(chatId, provider, {
      cwd: workspace,
      pairedAt: new Date().toISOString(),
      model: provider === "codex" ? "gpt-5.4" : "sonnet",
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
      return "아직 연결된 세션이 없습니다. `/startpair codex`, `/startpair claude`, `/startpair both` 중 하나로 시작하세요.";
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
      throw new Error("이 채팅방에는 아직 연결된 세션이 없습니다. `/startpair codex`, `/startpair claude`, `/startpair both` 중 하나를 먼저 실행하세요.");
    }
    return mapping;
  }

  private ensurePaired(mapping: ChatMapping, provider: Provider): void {
    if (!mapping[provider]?.cwd) {
      throw new Error(`이 채팅방에는 ${provider} 세션이 없습니다. \`/startpair ${provider}\`로 먼저 연결하세요.`);
    }
  }

  private ensureConfigured(provider: Provider): void {
    if (!this.adapters[provider]) {
      throw new Error(`${provider} 어댑터가 설정되지 않았습니다. 설치 환경이나 .env 설정을 확인하세요.`);
    }
  }

  private async log(entry: LogEntry): Promise<void> {
    await this.store.appendLog(entry.chatId, JSON.stringify(entry));
  }

  private describeSession(session: ProviderSession): string {
    const state = session.sessionId ? session.sessionId : "pending-first-run";
    return `- ${session.provider}: ${state} @ ${session.cwd}`;
  }

  private async ensureWorkspaceExists(cwd: string): Promise<void> {
    const stat = await fs.stat(cwd).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error(`작업 경로를 찾을 수 없습니다: ${cwd}`);
    }
  }
}
