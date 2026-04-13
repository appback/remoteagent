import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { BridgeMode, Provider } from "./types.js";

dotenv.config();

const VALID_MODES = new Set<BridgeMode>(["codex", "claude", "compare"]);
const VALID_PROVIDERS = new Set<Provider>(["codex", "claude"]);

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readMode(name: string, fallback: BridgeMode): BridgeMode {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  if (!VALID_MODES.has(value as BridgeMode)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value as BridgeMode;
}

function readTimeout(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export const config = {
  telegramBotToken: readRequired("TELEGRAM_BOT_TOKEN"),
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || ".data"),
  defaultMode: readMode("DEFAULT_MODE", "codex"),
  commandTimeoutMs: readTimeout("COMMAND_TIMEOUT_MS", 120_000),
  commands: {
    codex: readOptional("CODEX_COMMAND"),
    claude: readOptional("CLAUDE_COMMAND"),
  } satisfies Record<Provider, string | undefined>,
};

export function hasProviderCommand(provider: Provider): boolean {
  return VALID_PROVIDERS.has(provider) && Boolean(config.commands[provider]);
}
