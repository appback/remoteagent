import process from "node:process";
import { spawn } from "node:child_process";

export function spawnWithPlatformShell(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", "call", bin, ...args], {
          cwd,
          env: process.env,
        })
      : spawn(bin, args, {
          cwd,
          env: process.env,
        });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      command.kill("SIGTERM");
    }, timeoutMs);

    command.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    command.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    command.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    if (input !== undefined) {
      command.stdin.write(input);
    }
    command.stdin.end();

    command.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
