export type Provider = "codex" | "claude";

export type BridgeMode = Provider | "compare";

export type ProviderSession = {
  provider: Provider;
  cwd: string;
  pairedAt: string;
  sessionId?: string;
  model?: string;
  lastUsedAt?: string;
};

export type ChatMapping = {
  chatId: string;
  mode: BridgeMode;
  codex?: ProviderSession;
  claude?: ProviderSession;
  updatedAt: string;
};

export type BridgeState = {
  chats: Record<string, ChatMapping>;
};

export type ProviderRequest = {
  chatId: string;
  message: string;
  cwd: string;
  sessionId?: string;
  model?: string;
};

export type ProviderResponse = {
  provider: Provider;
  sessionId: string;
  cwd: string;
  output: string;
};

export type LogEntry = {
  timestamp: string;
  chatId: string;
  provider: Provider | "telegram";
  direction: "in" | "out";
  sessionId?: string;
  text: string;
};
