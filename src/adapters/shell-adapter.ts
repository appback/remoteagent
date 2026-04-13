import process from "node:process";
import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";
import type { Provider, ProviderRequest, ProviderResponse } from "../types.js";
import type { ProviderAdapter } from "./provider-adapter.js";

const exec = promisify(execCallback);

export class ShellAdapter implements ProviderAdapter {
  constructor(
    private readonly provider: Provider,
    private readonly command: string,
    private readonly timeoutMs: number,
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const env = {
      ...process.env,
      BRIDGE_PROVIDER: this.provider,
      BRIDGE_CHAT_ID: request.chatId,
      BRIDGE_SESSION_ID: request.sessionId,
      BRIDGE_MESSAGE: request.message,
    };

    const { stdout, stderr } = await exec(this.command, {
      env,
      timeout: this.timeoutMs,
      maxBuffer: 1024 * 1024,
    });

    const output = stdout.trim() || stderr.trim();
    if (!output) {
      throw new Error(`${this.provider} command completed without output`);
    }

    return {
      provider: this.provider,
      sessionId: request.sessionId,
      output,
    };
  }
}
