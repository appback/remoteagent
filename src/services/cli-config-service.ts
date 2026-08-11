import fs from "node:fs/promises";
import path from "node:path";

export type TelegramBotIdentity = {
  id: number;
  username: string;
};

type TelegramGetMeResponse = {
  ok?: boolean;
  description?: string;
  result?: {
    id?: number;
    username?: string;
  };
};

export type RegisterTelegramBotOptions = {
  dataDir: string;
  token: string;
  ownerId: string;
  identity?: TelegramBotIdentity;
};

export type RegisterTelegramBotResult = {
  identity: TelegramBotIdentity;
  envPath: string;
  added: boolean;
  botCount: number;
};

export async function registerTelegramBot(options: RegisterTelegramBotOptions): Promise<RegisterTelegramBotResult> {
  const token = options.token.trim();
  const ownerId = options.ownerId.trim();
  assertBotToken(token);
  assertOwnerId(ownerId);

  const identity = options.identity ?? await fetchTelegramBotIdentity(token);
  const envPath = path.join(options.dataDir, ".env");
  const original = await fs.readFile(envPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const values = parseEnv(original);
  const configuredTokens = parseCsv(values.get("TELEGRAM_BOT_TOKENS") || values.get("TELEGRAM_BOT_TOKEN") || "");
  const configuredUsernames = parseCsv(values.get("TELEGRAM_BOT_USERNAMES") || "");
  const validIndexes = configuredTokens
    .map((configuredToken, index) => isBotToken(configuredToken) ? index : -1)
    .filter((index) => index >= 0);
  const tokens = validIndexes.map((index) => configuredTokens[index]!);
  const usernames = validIndexes.map((index) => configuredUsernames[index] || "");
  const existingIndex = tokens.indexOf(token);
  const usernameIndex = usernames.findIndex((value) => value.toLowerCase() === identity.username.toLowerCase());

  if (usernameIndex >= 0 && existingIndex < 0) {
    throw new Error(`Telegram bot @${identity.username} is already configured with another token.`);
  }

  const added = existingIndex < 0;
  if (added) {
    tokens.push(token);
    usernames.push(identity.username);
  } else {
    while (usernames.length < tokens.length) {
      usernames.push("");
    }
    usernames[existingIndex] = identity.username;
  }

  const next = upsertEnv(original, {
    TELEGRAM_BOT_TOKEN: tokens[0]!,
    TELEGRAM_BOT_TOKENS: tokens.join(","),
    TELEGRAM_BOT_USERNAMES: usernames.join(","),
    TELEGRAM_OWNER_ID: ownerId,
  });
  await atomicWrite(envPath, next, 0o600);

  return {
    identity,
    envPath,
    added,
    botCount: tokens.length,
  };
}

export async function readConfiguredOwnerId(dataDir: string): Promise<string | undefined> {
  const envPath = path.join(dataDir, ".env");
  const text = await fs.readFile(envPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return parseEnv(text).get("TELEGRAM_OWNER_ID")?.trim() || undefined;
}

export async function fetchTelegramBotIdentity(token: string): Promise<TelegramBotIdentity> {
  assertBotToken(token);
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Telegram getMe request failed. Check this machine's network and DNS, then retry.");
  }

  let payload: TelegramGetMeResponse;
  try {
    payload = await response.json() as TelegramGetMeResponse;
  } catch {
    throw new Error(`Telegram getMe returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok || !payload.ok || !payload.result?.id || !payload.result.username) {
    throw new Error(payload.description || `Telegram rejected the supplied bot token (HTTP ${response.status}).`);
  }

  return {
    id: payload.result.id,
    username: payload.result.username,
  };
}

function assertBotToken(token: string): void {
  if (!isBotToken(token)) {
    throw new Error("Invalid Telegram bot token format.");
  }
}

function isBotToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token);
}

function assertOwnerId(ownerId: string): void {
  if (!/^\d+$/.test(ownerId)) {
    throw new Error("Telegram owner ID must contain digits only.");
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnv(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) {
      result.set(match[1]!, match[2]!);
    }
  }
  return result;
}

function upsertEnv(text: string, replacements: Record<string, string>): string {
  const remaining = new Map(Object.entries(replacements));
  const lines = text.split(/\r?\n/);
  const output: string[] = [];

  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (key && remaining.has(key)) {
      output.push(`${key}=${remaining.get(key)}`);
      remaining.delete(key);
    } else if (line || output.length > 0) {
      output.push(line);
    }
  }

  while (output.at(-1) === "") {
    output.pop();
  }
  for (const [key, value] of remaining) {
    output.push(`${key}=${value}`);
  }
  return `${output.join("\n")}\n`;
}

async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
    await fs.chmod(tempPath, mode).catch(() => undefined);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, mode).catch(() => undefined);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
