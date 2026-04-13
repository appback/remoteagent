import crypto from "node:crypto";
import type { ProviderAdapter } from "../adapters/provider-adapter.js";
import { hasProviderCommand } from "../config.js";
import type {
  BridgeMode,
  ChatMapping,
  LogEntry,
  Provider,
  ProviderResponse,
} from "../types.js";
import { FileStore } from "../store/file-store.js";

export class BridgeService {
  constructor(
    private readonly store: FileStore,
    private readonly adapters: Partial<Record<Provider, ProviderAdapter>>,
  ) {}

  async startPair(chatId: string, provider: Provider): Promise<ChatMapping> {
    const existing = await this.store.getChat(chatId);
    if (existing?.[provider]) {
      return existing;
    }

    const sessionId = this.createSessionId(provider);
    return this.store.upsertProvider(chatId, provider, sessionId);
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
          sessionId: session!.sessionId,
          message,
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
      ? `- codex: ${mapping.codex.sessionId}`
      : "- codex: not paired";
    const claude = mapping.claude
      ? `- claude: ${mapping.claude.sessionId}`
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

  private createSessionId(provider: Provider): string {
    return `${provider}-${crypto.randomUUID()}`;
  }

  private async requireChat(chatId: string): Promise<ChatMapping> {
    const mapping = await this.store.getChat(chatId);
    if (!mapping) {
      throw new Error("이 채팅방에는 아직 연결된 세션이 없습니다. `/startpair codex`, `/startpair claude`, `/startpair both` 중 하나를 먼저 실행하세요.");
    }
    return mapping;
  }

  private ensurePaired(mapping: ChatMapping, provider: Provider): void {
    if (!mapping[provider]) {
      throw new Error(`이 채팅방에는 ${provider} 세션이 없습니다. \`/startpair ${provider}\`로 먼저 연결하세요.`);
    }
  }

  private ensureConfigured(provider: Provider): void {
    if (!hasProviderCommand(provider) || !this.adapters[provider]) {
      throw new Error(`${provider} 어댑터가 설정되지 않았습니다. .env의 ${provider.toUpperCase()}_COMMAND 값을 확인하세요.`);
    }
  }

  private async log(entry: LogEntry): Promise<void> {
    await this.store.appendLog(entry.chatId, JSON.stringify(entry));
  }
}
