export type Provider = "codex" | "claude";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type BridgeMode = Provider;

export type ProviderSession = {
  provider: Provider;
  cwd: string;
  pairedAt: string;
  sessionId?: string;
  model?: string;
  lastUsedAt?: string;
  sandboxMode?: CodexSandboxMode;
};

export type SessionRecord = {
  sessionId: string;
  publicId: string;
  mode: BridgeMode;
  workspace: string;
  codex?: ProviderSession;
  claude?: ProviderSession;
  createdAt: string;
  updatedAt: string;
};

export type ChatBinding = {
  botId?: string;
  chatId: string;
  sessionId: string;
  boundAt: string;
  updatedAt: string;
};

export type ChatSession = {
  botId?: string;
  chatId: string;
  binding: ChatBinding;
  session: SessionRecord;
};

export type BridgeState = {
  chats: Record<string, ChatBinding>;
  sessions: Record<string, SessionRecord>;
};

export type ProviderRequest = {
  botId?: string;
  chatId: string;
  remoteSessionId: string;
  message: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
};

export type ProviderResponse = {
  provider: Provider;
  sessionId: string;
  cwd: string;
  output: string;
};

export type LogSource = Provider | "telegram" | "pc-ui" | "system";

export type LogEntry = {
  timestamp: string;
  remoteSessionId: string;
  botId?: string;
  chatId?: string;
  provider: LogSource;
  direction: "in" | "out" | "system";
  sessionId?: string;
  text: string;
};
