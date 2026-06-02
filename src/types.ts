export type Provider = "codex" | "claude";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type TelegramBotRole = "general" | "report";

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

export type TelegramReportTarget = {
  transport: "telegram";
  botId: string;
  chatId: string;
  username?: string;
  setAt: string;
};

export type TelegramContact = {
  transport: "telegram";
  botId: string;
  botUsername?: string;
  chatId: string;
  chatType: string;
  ownerUserId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  lastSeenAt: string;
};

export type SessionRecord = {
  sessionId: string;
  publicId: string;
  mode: BridgeMode;
  workspace: string;
  workspaceUid?: string;
  reportTarget?: TelegramReportTarget;
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

export type BridgeSettings = {
  defaultStartMode?: Provider;
};

export type BridgeState = {
  chats: Record<string, ChatBinding>;
  sessions: Record<string, SessionRecord>;
  telegramContacts: Record<string, TelegramContact>;
  settings: BridgeSettings;
};

export type ProviderRequest = {
  botId?: string;
  chatId: string;
  remoteSessionId: string;
  publicSessionId?: string;
  message: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
};

export type ProviderResponse = {
  provider: Provider;
  sessionId: string;
  publicSessionId?: string;
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
