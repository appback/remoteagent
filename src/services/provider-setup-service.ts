import process from "node:process";
import { spawn } from "node:child_process";
import type { Provider } from "../types.js";

export type SetupExecutionResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export class ProviderSetupService {
  constructor(
    private readonly timeoutMs: number,
    private readonly isProviderAvailable: (provider: Provider) => boolean,
    private readonly installCommands: Partial<Record<Provider, string | undefined>>,
    private readonly claudeLoginStartCommand?: string,
    private readonly claudeLoginFinishCommand?: string,
  ) {}

  async install(provider: Provider): Promise<{ provider: Provider; before: boolean; after: boolean; output: string }> {
    const before = this.isProviderAvailable(provider);
    if (before) {
      return {
        provider,
        before,
        after: true,
        output: `${provider} is already installed on this machine.`,
      };
    }

    const command = this.installCommands[provider]?.trim();
    if (!command) {
      throw new Error(this.installGuidance(provider));
    }

    const result = await this.execute(command, {});
    const after = this.isProviderAvailable(provider);
    if (result.code !== 0) {
      throw new Error(this.formatFailure(`${provider} install failed.`, result));
    }

    return {
      provider,
      before,
      after,
      output: this.formatSuccess(
        `${provider} install finished.`,
        result,
        after ? `${provider} is now available.` : `${provider} install command finished, but the CLI is still not detected.`,
      ),
    };
  }

  async startClaudeLogin(): Promise<string> {
    if (!this.isProviderAvailable("claude")) {
      throw new Error("Claude Code is not installed yet. Run /install claude first.");
    }

    const command = this.claudeLoginStartCommand?.trim();
    if (!command) {
      throw new Error([
        "No Claude login start command is configured.",
        "Set CLAUDE_LOGIN_START_COMMAND in ~/.remoteagent/.env, then run /login claude.",
      ].join("\n"));
    }

    const result = await this.execute(command, {});
    if (result.code !== 0) {
      throw new Error(this.formatFailure("Claude login start failed.", result));
    }

    const urls = this.extractUrls(`${result.stdout}\n${result.stderr}`);
    const urlBlock = urls.length > 0
      ? ["Open this URL and finish the login flow:", ...urls].join("\n")
      : undefined;

    return this.formatSuccess(
      "Claude login flow started.",
      result,
      urlBlock ? `${urlBlock}\n\nAfter login, send /login claude <token>.` : "After login, send /login claude <token>.",
    );
  }

  async finishClaudeLogin(token: string): Promise<string> {
    if (!this.isProviderAvailable("claude")) {
      throw new Error("Claude Code is not installed yet. Run /install claude first.");
    }

    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Usage: /login claude <token>");
    }

    const template = this.claudeLoginFinishCommand?.trim();
    if (!template) {
      throw new Error([
        "No Claude login finish command is configured.",
        "Set CLAUDE_LOGIN_FINISH_COMMAND in ~/.remoteagent/.env, then run /login claude <token>.",
      ].join("\n"));
    }

    const command = template.includes("{token}")
      ? template.replaceAll("{token}", this.shellEscape(trimmed))
      : template;
    const result = await this.execute(command, {
      REMOTEAGENT_AUTH_TOKEN: trimmed,
      CLAUDE_AUTH_TOKEN: trimmed,
    });

    if (result.code !== 0) {
      throw new Error(this.formatFailure("Claude login failed.", result));
    }

    return this.formatSuccess("Claude login succeeded.", result);
  }

  private extractUrls(text: string): string[] {
    const matches = text.match(/https?:\/\/[^\s)]+/g) ?? [];
    return [...new Set(matches)];
  }

  private installGuidance(provider: Provider): string {
    const commandName = provider === "codex" ? "CODEX_INSTALL_COMMAND" : "CLAUDE_INSTALL_COMMAND";
    return [
      `No install command is configured for ${provider}.`,
      `Set ${commandName} in ~/.remoteagent/.env, then run /install ${provider}.`,
    ].join("\n");
  }

  private async execute(command: string, extraEnv: Record<string, string>): Promise<SetupExecutionResult> {
    const launcher = this.resolveLauncher(command);

    return new Promise((resolve, reject) => {
      const child = spawn(launcher.file, launcher.args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...extraEnv,
        },
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
        resolve({
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });
  }

  private resolveLauncher(command: string): { file: string; args: string[] } {
    if (process.platform === "win32") {
      return {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          `[Console]::InputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
        ],
      };
    }

    return {
      file: "bash",
      args: ["-lc", command],
    };
  }

  private shellEscape(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  private formatFailure(prefix: string, result: SetupExecutionResult): string {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n\n").trim();
    return output ? `${prefix}\n\n${output}` : prefix;
  }

  private formatSuccess(prefix: string, result: SetupExecutionResult, suffix?: string): string {
    const body = [result.stdout, result.stderr].filter(Boolean).join("\n\n").trim();
    return [prefix, suffix, body].filter(Boolean).join("\n\n");
  }
}
