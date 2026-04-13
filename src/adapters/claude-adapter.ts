import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ProviderRequest, ProviderResponse } from "../types.js";
import type { ProviderAdapter } from "./provider-adapter.js";

export class ClaudeAdapter implements ProviderAdapter {
  constructor(
    private readonly claudeBin: string,
    private readonly timeoutMs: number,
    private readonly permissionMode: string,
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const sessionId = request.sessionId ?? randomUUID();
    const args = this.buildArgs(request, sessionId);
    const { stdout, stderr, code } = await this.runClaude(args, request.cwd);

    if (code !== 0) {
      throw new Error(this.formatProcessError(stdout, stderr));
    }

    const output = stdout.trim();
    if (!output) {
      throw new Error("Claude가 비어 있는 응답을 반환했습니다.");
    }

    return {
      provider: "claude",
      sessionId,
      cwd: request.cwd,
      output,
    };
  }

  private buildArgs(request: ProviderRequest, sessionId: string): string[] {
    const args = [
      "--print",
      "--output-format",
      "text",
      "--permission-mode",
      this.permissionMode,
    ];

    if (request.model) {
      args.push("--model", request.model);
    }

    if (request.sessionId) {
      args.push("--resume", sessionId, request.message);
    } else {
      args.push("--session-id", sessionId, request.message);
    }

    return args;
  }

  private runClaude(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBin, args, {
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

  private formatProcessError(stdout: string, stderr: string): string {
    const text = [stderr, stdout]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    return text || "Claude 실행이 실패했지만 출력이 비어 있습니다.";
  }
}
