export type Provider = "codex" | "claude";

export type BridgeMode = Provider | "compare";

export type ProviderSession = {
  provider: Provider;
  sessionId: string;
  pairedAt: string;
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
  sessionId: string;
  message: string;
};

export type ProviderResponse = {
  provider: Provider;
  sessionId: string;
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
