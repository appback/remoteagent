import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const CODEX_USAGE_FALLBACK_MODEL = "gpt-5.3-codex-spark";

export type CodexUsageLimit = {
  resetAt?: string;
  resetAtLabel?: string;
};

export type CodexUsageFallbackState = {
  fallbackModel: string;
  activatedAt: string;
  resetAt: string;
  resetAtLabel?: string;
};

export type CodexExecutionModel = {
  model: string;
  recoveryProbe: boolean;
};

export class CodexUsageFallbackService {
  private readonly statePath: string;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.statePath = path.join(dataDir, "codex-usage-fallback.json");
  }

  async selectExecutionModel(primaryModel: string): Promise<CodexExecutionModel> {
    if (primaryModel === CODEX_USAGE_FALLBACK_MODEL) {
      return { model: primaryModel, recoveryProbe: false };
    }

    const state = await this.read();
    if (!state) {
      return { model: primaryModel, recoveryProbe: false };
    }

    if (Date.parse(state.resetAt) > this.now().getTime()) {
      return { model: state.fallbackModel, recoveryProbe: false };
    }

    return { model: primaryModel, recoveryProbe: true };
  }

  async activate(limit: CodexUsageLimit): Promise<void> {
    if (!limit.resetAt || Date.parse(limit.resetAt) <= this.now().getTime()) {
      return;
    }

    await this.write({
      fallbackModel: CODEX_USAGE_FALLBACK_MODEL,
      activatedAt: this.now().toISOString(),
      resetAt: limit.resetAt,
      resetAtLabel: limit.resetAtLabel,
    });
  }

  async clear(): Promise<void> {
    await this.withWriteLock(async () => {
      await fs.unlink(this.statePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    });
  }

  async read(): Promise<CodexUsageFallbackState | undefined> {
    const raw = await fs.readFile(this.statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CodexUsageFallbackState>;
      if (
        parsed.fallbackModel !== CODEX_USAGE_FALLBACK_MODEL
        || typeof parsed.activatedAt !== "string"
        || typeof parsed.resetAt !== "string"
        || !Number.isFinite(Date.parse(parsed.resetAt))
      ) {
        return undefined;
      }
      return parsed as CodexUsageFallbackState;
    } catch {
      return undefined;
    }
  }

  private async write(state: CodexUsageFallbackState): Promise<void> {
    await this.withWriteLock(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, this.statePath);
    });
  }

  private async withWriteLock(task: () => Promise<void>): Promise<void> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      await task();
    } finally {
      release();
    }
  }
}

export function parseCodexUsageLimit(message: string): CodexUsageLimit | undefined {
  if (!/you(?:'|’)ve hit your usage limit\b/i.test(message)) {
    return undefined;
  }

  const resetMatch = /try again at\s+(.+?)(?:\.\s|\.?$|\n)/i.exec(message);
  const resetAtLabel = resetMatch?.[1]?.trim();
  if (!resetAtLabel) {
    return {};
  }

  const normalized = resetAtLabel.replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1");
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    return { resetAtLabel };
  }

  return {
    resetAt: new Date(timestamp).toISOString(),
    resetAtLabel,
  };
}
