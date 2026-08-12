import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CHILD_ENV_BLOCKED_PREFIXES = ["TELEGRAM_"];

export function buildProviderEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (CHILD_ENV_BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }

  const dataDir = process.env.REMOTEAGENT_DATA_DIR?.trim()
    || process.env.DATA_DIR?.trim()
    || path.join(os.homedir(), ".remoteagent");

  env.DATA_DIR = dataDir;
  env.REMOTEAGENT_DATA_DIR = dataDir;
  env.REMOTEAGENT_SECRET_BIN = resolveSecretHelperPath();
  env.PATH = buildRuntimePath(env.PATH);

  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  return env;
}

export function buildRuntimePath(
  existingPath = process.env.PATH,
  nodeExecutable = process.execPath,
  homeDir = os.homedir(),
): string {
  const entries = [
    path.dirname(nodeExecutable),
    path.join(homeDir, ".local", "bin"),
    ...(existingPath ?? "").split(path.delimiter),
  ].filter(Boolean);

  return [...new Set(entries)].join(path.delimiter);
}

function resolveSecretHelperPath(): string {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(adapterDir, "..", "secret-helper.js");
}
