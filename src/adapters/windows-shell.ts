import process from "node:process";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const activeCommands = new Map<string, ChildProcess>();
const CHILD_ENV_BLOCKED_PREFIXES = ["TELEGRAM_"];

function buildChildEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (CHILD_ENV_BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  const dataDir = process.env.DATA_DIR?.trim() || path.join(os.homedir(), ".remoteagent");
  env.REMOTEAGENT_DATA_DIR = dataDir;
  env.REMOTEAGENT_REPORT_BIN = path.resolve(process.cwd(), "dist", "report-telegram.js");
  env.REMOTEAGENT_SECRET_BIN = path.resolve(process.cwd(), "dist", "secret-helper.js");
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  return env;
}

export function spawnWithPlatformShell(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
  executionKey?: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", "call", bin, ...args], {
          cwd,
          env: buildChildEnv(extraEnv),
        })
      : spawn(bin, args, {
          cwd,
          env: buildChildEnv(extraEnv),
          detached: true,
        });

    if (executionKey) {
      activeCommands.set(executionKey, command);
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(command);
    }, timeoutMs);

    command.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    command.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    command.on("error", (error) => {
      clearTimeout(timer);
      if (executionKey && activeCommands.get(executionKey) === command) {
        activeCommands.delete(executionKey);
      }
      reject(error);
    });

    if (input !== undefined) {
      command.stdin.write(input);
    }
    command.stdin.end();

    command.on("close", (code) => {
      clearTimeout(timer);
      if (executionKey && activeCommands.get(executionKey) === command) {
        activeCommands.delete(executionKey);
      }
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

export function stopSpawnedExecution(executionKey: string): boolean {
  const command = activeCommands.get(executionKey);
  if (!command) {
    return false;
  }

  return terminateProcessTree(command);
}

function terminateProcessTree(command: ChildProcess): boolean {
  if (!command.pid) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(command.pid), "/t", "/f"], () => undefined);
    } else {
      process.kill(-command.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-command.pid!, "SIGKILL");
        } catch {
          // Process group already exited.
        }
      }, 3000).unref();
    }
    return true;
  } catch {
    return false;
  }
}
