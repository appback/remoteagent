import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ProviderRequest, ProviderResponse } from "../types.js";
import type { ProviderAdapter } from "./provider-adapter.js";

export class CodexAdapter implements ProviderAdapter {
  constructor(
    private readonly codexBin: string,
    private readonly timeoutMs: number,
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const outputPath = await this.createOutputPath();
    const args = request.sessionId
      ? [
          "exec",
          "resume",
          "--json",
          "--skip-git-repo-check",
          "-o",
          outputPath,
          request.sessionId,
          request.message,
        ]
      : this.buildExecArgs(request, outputPath);

    const { stdout, stderr, code } = await this.runCodex(args, request.cwd);

    try {
      if (code !== 0) {
        throw new Error(this.formatProcessError(stdout, stderr));
      }

      const sessionId = this.extractThreadId(stdout) ?? request.sessionId;
      if (!sessionId) {
        throw new Error("Codex 응답에서 session id를 찾지 못했습니다.");
      }

      const output = (await fs.readFile(outputPath, "utf8")).trim();
      if (!output) {
        throw new Error("Codex가 비어 있는 응답을 반환했습니다.");
      }

      return {
        provider: "codex",
        sessionId,
        cwd: request.cwd,
        output,
      };
    } finally {
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
      await fs.rm(path.dirname(outputPath), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async createOutputPath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remoteagent-codex-"));
    return path.join(dir, `${randomUUID()}.txt`);
  }

  private buildExecArgs(request: ProviderRequest, outputPath: string): string[] {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
    ];

    if (request.model) {
      args.push("-m", request.model);
    }

    args.push(
      "-o",
      outputPath,
      "-C",
      request.cwd,
      request.message,
    );

    return args;
  }

  private runCodex(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, args, {
        cwd,
        env: process.env,
        shell: process.platform === "win32",
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  }

  private extractThreadId(stdout: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) {
        continue;
      }

      try {
        const event = JSON.parse(line) as { type?: string; thread_id?: string };
        if (event.type === "thread.started" && event.thread_id) {
          return event.thread_id;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  private formatProcessError(stdout: string, stderr: string): string {
    const text = [stderr, stdout]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    return text || "Codex 실행이 실패했지만 출력이 비어 있습니다.";
  }
}
