import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const command = this.installCommands[provider]?.trim();
    if (!command) {
      if (before) {
        return {
          provider,
          before,
          after: true,
          output: `${provider} is already installed on this machine, but no install or update command is configured.`,
        };
      }

      throw new Error(this.installGuidance(provider));
    }

    const result = await this.execute(command, {});
    const after = this.isProviderAvailable(provider);
    if (result.code !== 0) {
      throw new Error(this.formatFailure(`${provider} ${before ? "update" : "install"} failed.`, result));
    }

    const authGuidance = await this.postInstallGuidance(provider, after);

    return {
      provider,
      before,
      after,
      output: this.formatSuccess(
        `${provider} ${before ? "update" : "install"} finished.`,
        result,
        [
          before
            ? (after ? `${provider} remains available after the update check.` : `${provider} update command finished, but the CLI is no longer detected.`)
            : (after ? `${provider} is now available.` : `${provider} install command finished, but the CLI is still not detected.`),
          authGuidance,
        ].filter(Boolean).join("\n\n"),
      ),
    };
  }

  async startCodexLogin(): Promise<string> {
    if (!this.isProviderAvailable("codex")) {
      throw new Error("Codex is not installed yet. Run /install codex first.");
    }

    try {
      const status = await this.execute("codex login status", {});
      const statusText = [status.stdout, status.stderr].filter(Boolean).join("\n");
      if (statusText && !/not logged in/i.test(statusText)) {
        return this.formatSuccess("Codex is already logged in on this machine.", status);
      }
    } catch {
      // Ignore status check failures and continue with device auth.
    }

    if (process.platform === "win32") {
      return [
        "Codex login requires local browser/device authentication on this machine.",
        "Run `codex login` or `codex login --device-auth` on the machine.",
      ].join("\n");
    }

    const logPath = path.join(os.tmpdir(), `remoteagent-codex-login-${Date.now()}.log`);
    await fs.writeFile(logPath, "", "utf8");
    await this.launchDetached("codex login --device-auth", logPath);

    const timeoutAt = Date.now() + 20_000;
    let lastText = "";
    while (Date.now() < timeoutAt) {
      try {
        lastText = await fs.readFile(logPath, "utf8");
      } catch {
        lastText = "";
      }

      const cleaned = this.stripAnsi(lastText).trim();
      const urls = this.extractUrls(cleaned);
      const deviceCode = this.extractCodexDeviceCode(cleaned);
      if (urls.length > 0) {
        return [
          "Codex login flow started.",
          "Open this URL and finish the login flow:",
          ...urls,
          deviceCode ? "" : undefined,
          deviceCode ? `One-time code: ${deviceCode}` : undefined,
          "",
          "After the browser flow finishes, use `/start` in this chat.",
        ].filter((line): line is string => typeof line === "string").join("\n");
      }

      if (/already logged in/i.test(cleaned)) {
        return [
          "Codex is already logged in on this machine.",
          cleaned,
        ].filter(Boolean).join("\n\n");
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (lastText.trim()) {
      const cleaned = this.stripAnsi(lastText).trim();
      return this.formatSuccess(
        "Codex login started, but no browser URL was captured yet.",
        { code: 0, stdout: cleaned, stderr: "" },
        "If the login URL is not shown above, run `/login codex` again or use `codex login --device-auth` directly on the machine.",
      );
    }

    throw new Error("Codex login start timed out before a browser URL was captured.");
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

  private async postInstallGuidance(provider: Provider, available: boolean): Promise<string | undefined> {
    if (!available) {
      return undefined;
    }

    if (provider === "codex") {
      try {
        const result = await this.execute("codex login status", {});
        const statusText = [result.stdout, result.stderr].filter(Boolean).join("\n");
        if (/not logged in/i.test(statusText)) {
          return [
            "Codex is installed but not logged in yet.",
            "Next step: run `/login codex` in this chat.",
            "If you prefer machine-side auth, you can use `codex login --device-auth` and complete the login in your browser.",
          ].join("\n");
        }
      } catch {
        return "Codex is installed. If this machine is not authenticated yet, run `/login codex` or use `codex login --device-auth` on the machine.";
      }
    }

    if (provider === "claude") {
      try {
        const result = await this.execute("claude auth status", {});
        const statusText = [result.stdout, result.stderr].filter(Boolean).join("\n");
        if (/not logged in|loggedIn:\s*false/i.test(statusText)) {
          return [
            "Claude Code is installed but not logged in yet.",
            "Next step: run `/login claude` or complete the configured Claude login flow on this machine.",
          ].join("\n");
        }
      } catch {
        return "Claude Code is installed. If this machine is not authenticated yet, run `/login claude` or complete the configured login flow.";
      }
    }

    return undefined;
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

  private stripAnsi(text: string): string {
    return text.replace(/\[[0-9;]*m/g, "");
  }

  private extractUrls(text: string): string[] {
    const matches = text.match(/https?:\/\/[^\s)]+/g) ?? [];
    return [...new Set(matches)];
  }

  private extractCodexDeviceCode(text: string): string | undefined {
    const codeMatch = text.match(/Enter this one-time code(?:\s*\(expires in .*?\))?\s*([A-Z0-9]{4}-[A-Z0-9]{5})/is)
      ?? text.match(/([A-Z0-9]{4}-[A-Z0-9]{5})/);
    return codeMatch?.[1];
  }

  private installGuidance(provider: Provider): string {
    const commandName = provider === "codex" ? "CODEX_INSTALL_COMMAND" : "CLAUDE_INSTALL_COMMAND";
    return [
      `No install command is configured for ${provider}.`,
      `Set ${commandName} in ~/.remoteagent/.env, then run /install ${provider}.`,
    ].join("\n");
  }

  private async launchDetached(command: string, logPath: string): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("Detached Codex login is not implemented on Windows.");
    }

    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await this.execute(`nohup ${command} > ${this.shellEscape(logPath)} 2>&1 </dev/null &`, {});
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
