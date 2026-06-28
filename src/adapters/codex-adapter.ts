import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexSandboxMode, ProviderRequest, ProviderResponse } from "../types.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { spawnWithPlatformShell } from "./windows-shell.js";

export class CodexAdapter implements ProviderAdapter {
  constructor(
    private readonly codexBin: string,
    private readonly timeoutMs: number | (() => number),
    private readonly sandboxMode?: CodexSandboxMode,
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const outputPath = await this.createOutputPath();
    const sandboxMode = request.sandboxMode ?? this.sandboxMode;
    const args = request.sessionId
      ? this.buildResumeArgs(request, outputPath, sandboxMode)
      : this.buildExecArgs(request, outputPath, sandboxMode);

    const { stdout, stderr, code, timedOut } = await this.runCodex(
      args,
      request.cwd,
      request.remoteSessionId,
      request.publicSessionId,
      request.message,
    );

    try {
      const sessionId = this.extractThreadId(stdout) ?? request.sessionId;
      const output = await this.readOutput(outputPath) || this.extractAgentMessage(stdout);

      if (sessionId && output) {
        return {
          provider: "codex",
          sessionId,
          cwd: request.cwd,
          output,
        };
      }

      if (code !== 0) {
        throw new Error(this.formatProcessError(stdout, stderr, timedOut, code));
      }

      if (timedOut) {
        throw new Error(this.formatTimeoutError());
      }

      if (!sessionId) {
        throw new Error("Codex response did not include a session id.");
      }

      if (!output) {
        throw new Error("Codex returned an empty response.");
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

  private buildExecArgs(request: ProviderRequest, outputPath: string, sandboxMode?: CodexSandboxMode): string[] {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
    ];

    if (request.model) {
      args.push("-m", request.model);
    }

    this.appendSandboxArgs(args, sandboxMode);

    args.push(
      "-o",
      outputPath,
      "-C",
      request.cwd,
    );

    this.appendPromptStdinArg(args);

    return args;
  }

  private buildResumeArgs(request: ProviderRequest, outputPath: string, sandboxMode?: CodexSandboxMode): string[] {
    const args = [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
    ];

    if (request.model) {
      args.push("-m", request.model);
    }

    this.appendSandboxArgs(args, sandboxMode);

    args.push(
      "-o",
      outputPath,
      request.sessionId!,
    );

    this.appendPromptStdinArg(args);

    return args;
  }

  private appendPromptStdinArg(args: string[]): void {
    args.push("--", "-");
  }

  private appendSandboxArgs(args: string[], sandboxMode?: CodexSandboxMode): void {
    if (!sandboxMode || sandboxMode === "read-only") {
      return;
    }

    if (sandboxMode === "workspace-write") {
      args.push("--full-auto");
      return;
    }

    if (sandboxMode === "danger-full-access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
  }

  private runCodex(
    args: string[],
    cwd: string,
    remoteSessionId: string,
    publicSessionId: string | undefined,
    input?: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    return spawnWithPlatformShell(this.codexBin, args, cwd, this.currentTimeoutMs(), input, remoteSessionId, {
      REMOTEAGENT_SESSION_ID: remoteSessionId,
      REMOTEAGENT_PUBLIC_SESSION_ID: publicSessionId ?? "",
      REMOTEAGENT_WORKSPACE: cwd,
    });
  }

  private extractThreadId(stdout: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) {
        continue;
      }

      try {
        const event = JSON.parse(line) as { thread_id?: string };
        if (event.thread_id) {
          return event.thread_id;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  private extractAgentMessage(stdout: string): string {
    let latest = "";

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) {
        continue;
      }

      try {
        const event = JSON.parse(line) as {
          type?: string;
          item?: {
            type?: string;
            text?: string;
          };
        };
        if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
          latest = event.item.text.trim();
        }
      } catch {
        continue;
      }
    }

    return latest;
  }

  private async readOutput(outputPath: string): Promise<string> {
    return (await fs.readFile(outputPath, "utf8").catch(() => "")).trim();
  }

  private formatProcessError(stdout: string, stderr: string, timedOut = false, code?: number | null): string {
    const structured = this.extractStructuredError(stdout, stderr);
    if (structured) {
      return structured;
    }

    const text = this.extractPlainTextError(stdout, stderr);
    if (text) {
      return text;
    }

    return timedOut
      ? this.formatTimeoutError()
      : `Codex process exited with code ${code ?? "unknown"} without stdout/stderr.`;
  }

  private extractStructuredError(stdout: string, stderr: string): string | undefined {
    const messages: string[] = [];

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) {
        continue;
      }

      try {
        const event = JSON.parse(line) as {
          type?: string;
          message?: string;
          error?: string | { message?: string };
          errors?: string[];
          is_error?: boolean;
        };

        if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
          messages.push(event.message.trim());
        }

        if (event.is_error) {
          if (Array.isArray(event.errors)) {
            for (const entry of event.errors) {
              if (typeof entry === "string" && entry.trim()) {
                messages.push(entry.trim());
              }
            }
          }

          if (typeof event.error === "string" && event.error.trim()) {
            messages.push(event.error.trim());
          } else if (event.error && typeof event.error === "object" && typeof event.error.message === "string" && event.error.message.trim()) {
            messages.push(event.error.message.trim());
          }

          if (typeof event.message === "string" && event.message.trim()) {
            messages.push(event.message.trim());
          }
        }
      } catch {
        continue;
      }
    }

    for (const chunk of [stderr, stdout]) {
      const trimmed = chunk.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as { message?: string; error?: { message?: string }; errors?: string[] };
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          messages.push(parsed.message.trim());
        }
        if (parsed.error && typeof parsed.error.message === "string" && parsed.error.message.trim()) {
          messages.push(parsed.error.message.trim());
        }
        if (Array.isArray(parsed.errors)) {
          for (const entry of parsed.errors) {
            if (typeof entry === "string" && entry.trim()) {
              messages.push(entry.trim());
            }
          }
        }
      } catch {
        // ignore non-JSON blocks
      }
    }

    return messages.at(-1);
  }

  private extractPlainTextError(stdout: string, stderr: string): string {
    const sanitize = (value: string) => value
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("{"))
      .join("\n")
      .trim();

    return [sanitize(stderr), sanitize(stdout)]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  private formatTimeoutError(): string {
    return `Codex timed out after ${Math.round(this.currentTimeoutMs() / 1000)}s without returning a final reply.`;
  }

  private currentTimeoutMs(): number {
    return typeof this.timeoutMs === "function" ? this.timeoutMs() : this.timeoutMs;
  }
}
