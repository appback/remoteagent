import process from "node:process";
import { spawn } from "node:child_process";

export type RemoteShellKind = "native" | "cmd" | "bash";

export type RemoteShellResult = {
  shell: string;
  code: number | null;
  stdout: string;
  stderr: string;
};

export class RemoteShellService {
  constructor(
    private readonly timeoutMs: number,
    private readonly maxBufferBytes: number = 1024 * 1024,
  ) {}

  async execute(command: string, cwd: string, kind: RemoteShellKind): Promise<RemoteShellResult> {
    const { file, args, shell } = this.resolveLauncher(command, kind);

    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let exceeded = false;

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => {
        if (exceeded) {
          return;
        }

        stdout += chunk.toString();
        if (stdout.length + stderr.length > this.maxBufferBytes) {
          exceeded = true;
          child.kill("SIGTERM");
        }
      });

      child.stderr.on("data", (chunk) => {
        if (exceeded) {
          return;
        }

        stderr += chunk.toString();
        if (stdout.length + stderr.length > this.maxBufferBytes) {
          exceeded = true;
          child.kill("SIGTERM");
        }
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);

        if (exceeded) {
          reject(new Error("Remote shell output exceeded the size limit."));
          return;
        }

        resolve({
          shell,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });
  }

  private resolveLauncher(command: string, kind: RemoteShellKind): { file: string; args: string[]; shell: string } {
    if (process.platform === "win32") {
      if (kind === "cmd") {
        return {
          file: "cmd.exe",
          args: ["/d", "/c", command],
          shell: "cmd",
        };
      }

      if (kind === "bash") {
        return {
          file: "bash",
          args: ["-lc", command],
          shell: "bash",
        };
      }

      return {
        file: "powershell.exe",
        args: ["-NoProfile", "-Command", command],
        shell: "powershell",
      };
    }

    if (kind === "cmd") {
      throw new Error("cmd shell is only available on Windows.");
    }

    return {
      file: "bash",
      args: ["-lc", command],
      shell: "bash",
    };
  }
}
