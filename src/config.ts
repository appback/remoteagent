import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { BridgeMode, Provider } from "./types.js";

dotenv.config();

const defaultDataDir = path.resolve(process.env.DATA_DIR?.trim() || path.join(os.homedir(), ".remoteagent"));
const installedEnvPath = path.join(defaultDataDir, ".env");
if (fs.existsSync(installedEnvPath)) {
  dotenv.config({ path: installedEnvPath, override: true });
}

const VALID_MODES = new Set<BridgeMode>(["codex", "claude", "compare"]);
const VALID_CODEX_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readTelegramBotTokens(): string[] {
  const multiValue = process.env.TELEGRAM_BOT_TOKENS?.trim();
  if (multiValue) {
    const tokens = multiValue
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (tokens.length === 0) {
      throw new Error("Invalid TELEGRAM_BOT_TOKENS: no non-empty tokens found");
    }

    return [...new Set(tokens)];
  }

  return [readRequired("TELEGRAM_BOT_TOKEN")];
}

function readTelegramBotUsernames(): string[] {
  const raw = process.env.TELEGRAM_BOT_USERNAMES?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
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

function readNonNegativeTimeout(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  throw new Error(`Invalid ${name}: ${value}`);
}

function readPort(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function readCodexSandboxMode(name: string): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  if (!VALID_CODEX_SANDBOX_MODES.has(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value as "read-only" | "workspace-write" | "danger-full-access";
}

export const config = {
  telegramBotTokens: readTelegramBotTokens(),
  telegramBotUsernames: readTelegramBotUsernames(),
  telegramOwnerId: readOptional("TELEGRAM_OWNER_ID"),
  telegramMessageBatchMs: readNonNegativeTimeout("TELEGRAM_MESSAGE_BATCH_MS", 1500),
  dataDir: defaultDataDir,
  defaultMode: readMode("DEFAULT_MODE", "codex"),
  defaultWorkspace: path.resolve(process.env.DEFAULT_WORKSPACE?.trim() || os.homedir()),
  commandTimeoutMs: readTimeout("COMMAND_TIMEOUT_MS", 120_000),
  codexBin: readOptional("CODEX_BIN") || "codex",
  codexSandboxMode: readCodexSandboxMode("CODEX_SANDBOX_MODE"),
  claudeBin: readOptional("CLAUDE_BIN") || "claude",
  claudePermissionMode: readOptional("CLAUDE_PERMISSION_MODE") || "bypassPermissions",
  localUiEnabled: readBoolean("LOCAL_UI_ENABLED", true),
  localUiHost: readOptional("LOCAL_UI_HOST") || "127.0.0.1",
  localUiPort: readPort("LOCAL_UI_PORT", 3794),
  commands: {
    codex: readOptional("CODEX_COMMAND"),
    claude: readOptional("CLAUDE_COMMAND"),
  } satisfies Record<Provider, string | undefined>,
};
