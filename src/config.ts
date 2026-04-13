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
  dataDir: defaultDataDir,
  defaultMode: readMode("DEFAULT_MODE", "codex"),
  defaultWorkspace: path.resolve(process.env.DEFAULT_WORKSPACE?.trim() || os.homedir()),
  commandTimeoutMs: readTimeout("COMMAND_TIMEOUT_MS", 120_000),
  codexBin: readOptional("CODEX_BIN") || "codex",
  commands: {
    codex: readOptional("CODEX_COMMAND"),
    claude: readOptional("CLAUDE_COMMAND"),
  } satisfies Record<Provider, string | undefined>,
};
