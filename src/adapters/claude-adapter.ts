import process from "node:process";
import { randomUUID } from "node:crypto";
import type { ProviderRequest, ProviderResponse } from "../types.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { spawnWithPlatformShell } from "./windows-shell.js";

export class ClaudeAdapter implements ProviderAdapter {
  constructor(
    private readonly claudeBin: string,
    private readonly timeoutMs: number,
    private readonly permissionMode: string,
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const sessionId = request.sessionId ?? randomUUID();
    const args = this.buildArgs(request, sessionId);
    const { stdout, stderr, code, timedOut } = await this.runClaude(
      args,
      request.cwd,
      request.remoteSessionId,
      request.publicSessionId,
    );

    if (code !== 0) {
      throw new Error(this.formatProcessError(stdout, stderr, timedOut));
    }

    if (timedOut) {
      throw new Error(this.formatTimeoutError());
    }

    const output = stdout.trim();
    if (!output) {
      throw new Error("Claude returned an empty response.");
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

  private runClaude(
    args: string[],
    cwd: string,
    remoteSessionId: string,
    publicSessionId?: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    return spawnWithPlatformShell(this.claudeBin, args, cwd, this.timeoutMs, undefined, remoteSessionId, {
      REMOTEAGENT_SESSION_ID: remoteSessionId,
      REMOTEAGENT_PUBLIC_SESSION_ID: publicSessionId ?? "",
      REMOTEAGENT_WORKSPACE: cwd,
    });
  }

  private formatProcessError(stdout: string, stderr: string, timedOut = false): string {
    const text = [stderr, stdout]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) {
      return text;
    }

    return timedOut
      ? this.formatTimeoutError()
      : "Claude execution failed without any output.";
  }

  private formatTimeoutError(): string {
    return `Claude timed out after ${Math.round(this.timeoutMs / 1000)}s without returning a final reply.`;
  }
}
