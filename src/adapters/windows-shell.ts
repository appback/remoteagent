import process from "node:process";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { buildProviderEnv } from "./runtime-env.js";

const activeCommands = new Map<string, ChildProcess>();

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
          env: buildProviderEnv(extraEnv),
        })
      : spawn(bin, args, {
          cwd,
          env: buildProviderEnv(extraEnv),
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

export function terminateAllSpawnedExecutions(): number {
  let stopped = 0;
  for (const [key, command] of activeCommands.entries()) {
    if (terminateProcessTree(command)) {
      stopped += 1;
    }
    activeCommands.delete(key);
  }
  return stopped;
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
