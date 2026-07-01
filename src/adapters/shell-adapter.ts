import process from "node:process";
import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";
import type { Provider, ProviderRequest, ProviderResponse } from "../types.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { buildProviderEnv } from "./runtime-env.js";

const exec = promisify(execCallback);

export class ShellAdapter implements ProviderAdapter {
  constructor(
    private readonly provider: Provider,
    private readonly command: string,
    private readonly timeoutMs: number | (() => number),
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const env = buildProviderEnv({
      BRIDGE_PROVIDER: this.provider,
      BRIDGE_BOT_ID: request.botId ?? "",
      BRIDGE_CHAT_ID: request.chatId,
      BRIDGE_SESSION_ID: request.sessionId ?? "",
      BRIDGE_PUBLIC_SESSION_ID: request.publicSessionId ?? "",
      BRIDGE_CWD: request.cwd,
      BRIDGE_MESSAGE: request.message,
    });

    const { stdout, stderr } = await exec(this.command, {
      env,
      timeout: this.currentTimeoutMs(),
      maxBuffer: 1024 * 1024,
    });

    const output = stdout.trim() || stderr.trim();
    if (!output) {
      throw new Error(`${this.provider} command completed without output`);
    }

    return {
      provider: this.provider,
      sessionId: request.sessionId ?? "",
      cwd: request.cwd,
      output,
    };
  }

  private currentTimeoutMs(): number {
    return typeof this.timeoutMs === "function" ? this.timeoutMs() : this.timeoutMs;
  }
}
