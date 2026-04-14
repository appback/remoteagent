export type Provider = "codex" | "claude";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type BridgeMode = Provider | "compare";

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
  mode: BridgeMode;
  workspace: string;
  codex?: ProviderSession;
  claude?: ProviderSession;
  createdAt: string;
  updatedAt: string;
};

export type ChatBinding = {
  chatId: string;
  sessionId: string;
  boundAt: string;
  updatedAt: string;
};

export type ChatSession = {
  chatId: string;
  binding: ChatBinding;
  session: SessionRecord;
};

export type BridgeState = {
  chats: Record<string, ChatBinding>;
  sessions: Record<string, SessionRecord>;
};

export type ProviderRequest = {
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

export type LogEntry = {
  timestamp: string;
  remoteSessionId: string;
  chatId?: string;
  provider: Provider | "telegram" | "system";
  direction: "in" | "out" | "system";
  sessionId?: string;
  text: string;
};
