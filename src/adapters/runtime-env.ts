import os from "node:os";
import path from "node:path";
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

  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  return env;
}

function resolveSecretHelperPath(): string {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(adapterDir, "..", "secret-helper.js");
}
