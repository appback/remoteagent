import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { createBot } from "./bot.js";
import { ShellAdapter } from "./adapters/shell-adapter.js";
import { config } from "./config.js";
import { FileStore } from "./store/file-store.js";
import { BridgeService } from "./services/bridge-service.js";
import { BotManagementService } from "./services/bot-management-service.js";
import { LocalUiService } from "./services/local-ui-service.js";
import type { ProviderAdapter } from "./adapters/provider-adapter.js";
import type { Provider } from "./types.js";
import type { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

const execFileAsync = promisify(execFile);
const TELEGRAM_GET_UPDATES_HTTP_TIMEOUT_SECONDS = 30;
const TELEGRAM_GET_UPDATES_CURL_TIMEOUT_SECONDS = 60;
let processLockPath: string | undefined;
let telegramTransportStatusPath: string | undefined;
const telegramTransportStatuses: Record<string, Record<string, unknown>> = {};
let telegramPollingLimiter: AsyncSemaphore;

async function main(): Promise<void> {
  processLockPath = await acquireProcessLock(config.dataDir);
  telegramTransportStatusPath = path.join(config.dataDir, "telegram-transport.json");
  telegramPollingLimiter = new AsyncSemaphore(config.telegramPollingMaxConcurrency);
  registerProcessLifecycle();

  const store = new FileStore(config.dataDir, config.defaultMode);
  await store.init();

  const adapters: Partial<Record<Provider, ProviderAdapter>> = {
    codex: config.commands.codex
      ? new ShellAdapter("codex", config.commands.codex, () => config.commandTimeoutMs)
      : new CodexAdapter(
        config.codexBin,
        () => config.commandTimeoutMs,
        config.codexSandboxMode,
      ),
    claude: config.commands.claude
      ? new ShellAdapter("claude", config.commands.claude, () => config.commandTimeoutMs)
      : new ClaudeAdapter(
        config.claudeBin,
        () => config.commandTimeoutMs,
        config.claudePermissionMode,
      ),
  };

  const isProviderInstalled = (provider: Provider): boolean => {
    if (config.commands[provider]) {
      return true;
    }
    return provider === "codex"
      ? commandExists(config.codexBin)
      : commandExists(config.claudeBin);
  };

  const availableProviders = (["codex", "claude"] as const).filter((provider) => isProviderInstalled(provider));
  console.log(`Available providers: ${availableProviders.length > 0 ? availableProviders.join(", ") : "none"}`);
  const bridge = new BridgeService(
    store,
    adapters,
    config.defaultWorkspace,
    config.workspaceRoot,
    isProviderInstalled,
    config.defaultMode,
    config.codexSandboxMode,
  );
  const botManagement = new BotManagementService(
    config.dataDir,
    config.botRestartServiceName,
    config.botRestartHelperPath,
  );
  if (config.localUiEnabled) {
    const localUi = new LocalUiService(bridge, config.localUiHost, config.localUiPort);
    await localUi.start()
      .then(() => {
        console.log(`Local UI is ready at http://${config.localUiHost}:${config.localUiPort}`);
      })
      .catch((error) => {
        console.error("Local UI failed to start:", error);
      });
  }

  const botInfos = config.telegramBotTokens.map((token, index) => buildBotInfo(token, index));
  const bots = config.telegramBotTokens.map((token, index) => createBot(token, bridge, botManagement, botInfos[index]!));

  if (config.telegramCommandMenuEnabled) {
    for (const bot of bots) {
      const username = bot.botInfo.username;
      await configureTelegramCommandMenu(bot).catch((error) => {
        console.error(`Failed to configure command menu for @${username}:`, error);
      });
      console.log(`Bot @${username} is ready`);
    }
  } else {
    console.log("Telegram command menu registration is disabled.");
    for (const bot of bots) {
      console.log(`Bot @${bot.botInfo.username} is ready`);
    }
  }

  await botManagement.reportPendingOperationResult().catch((error) => {
    console.error("Failed to report pending bot operation result:", error);
  });

  await Promise.all(bots.map((bot, index) => startManualPolling(bot, index)));
}

async function configureTelegramCommandMenu(bot: Bot): Promise<void> {
  const commands = [
    { command: "start", description: "Start a new Codex or Claude session" },
    { command: "list", description: "List sessions" },
    { command: "switch", description: "Switch to a session" },
    { command: "status", description: "Show current session status" },
    { command: "state", description: "Show or edit session state notes" },
    { command: "option", description: "Show or change runtime options" },
    { command: "model", description: "Show or change provider model" },
    { command: "stop", description: "Stop active work and clear queued messages" },
    { command: "batch", description: "Collect and send a multi-message batch" },
    { command: "bots", description: "List configured Telegram bots" },
    { command: "bot", description: "Manage Telegram bots" },
    { command: "install", description: "Install or update Codex or Claude" },
    { command: "login", description: "Run provider login flow" },
    { command: "reset", description: "Clear this chat binding" },
    { command: "help", description: "Show command help" },
  ];

  const token = (bot as unknown as { token?: string }).token;
  if (!token) {
    throw new Error("Telegram bot token is unavailable for command menu registration.");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await setTelegramCommandsViaCurl(token, commands);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(1000 * attempt);
      }
    }
  }

  throw lastError;
}

async function setTelegramCommandsViaCurl(
  token: string,
  commands: Array<{ command: string; description: string }>,
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const payload = JSON.stringify({ commands });
  let stdout: string;
  let stderr: string | undefined;

  try {
    const result = await execFileAsync("curl", [
      "-sS",
      "-4",
      "--max-time",
      "20",
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
      url,
    ]);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    throw new Error(`Telegram setMyCommands curl failed: ${formatCurlError(error)}`);
  }

  if (stderr?.trim()) {
    console.error(`curl stderr for setMyCommands: ${stderr.trim()}`);
  }

  const parsed = JSON.parse(stdout) as { ok?: boolean; description?: string };
  if (!parsed.ok) {
    throw new Error(parsed.description || "Telegram setMyCommands failed.");
  }
}

function formatCurlError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "").trim()
    : "";

  return [code ? `code=${code}` : undefined, stderr || error.message]
    .filter(Boolean)
    .join(" ");
}

main().catch((error: unknown) => {
  console.error("RemoteAgent fatal error:", error);
  releaseProcessLockSync();
  process.exitCode = 1;
});

async function startManualPolling(bot: Bot, index: number): Promise<never> {
  const pollingBot = bot as unknown as {
    token: string;
    handleUpdates(updates: TelegramUpdate[]): Promise<void>;
    botInfo: { username?: string };
  };
  let offset = 0;
  let consecutiveFailures = 0;
  let lastFailureLogAt = 0;
  const activeHandlers = new Set<Promise<void>>();
  const initialDelayMs = Math.min(30_000, index * 3_000 + stableJitterMs(pollingBot.botInfo.username));
  if (initialDelayMs > 0) {
    console.log(`Starting polling for @${pollingBot.botInfo.username} in ${formatDuration(initialDelayMs)}.`);
    await sleep(initialDelayMs);
  }

  while (true) {
    try {
      const payload = await telegramPollingLimiter.run(() => getUpdatesViaCurl(pollingBot.token, offset));
      if (consecutiveFailures > 0) {
        console.warn(`Telegram polling recovered for @${pollingBot.botInfo.username} after ${consecutiveFailures} failure(s).`);
        await writeTelegramTransportStatus(pollingBot.botInfo.username, {
          status: "ok",
          consecutiveFailures: 0,
          lastRecoveredAt: new Date().toISOString(),
        }).catch((error) => {
          console.error(`Failed to write Telegram transport recovery status for @${pollingBot.botInfo.username}:`, error);
        });
        consecutiveFailures = 0;
        lastFailureLogAt = 0;
      }

      if (payload.result.length === 0) {
        continue;
      }

      const orderedUpdates = orderUpdatesForDispatch(payload.result);
      const stopUpdates = orderedUpdates.filter((update) => isStopCommandUpdate(update));
      if (stopUpdates.length > 0) {
        for (const update of stopUpdates) {
          await pollingBot.handleUpdates([update]).catch((error) => {
            console.error(`Telegram stop update ${update.update_id} handler failed for @${pollingBot.botInfo.username}:`, error);
          });
        }

        const skipped = orderedUpdates.length - stopUpdates.length;
        if (skipped > 0) {
          console.log(`Skipped ${skipped} queued update(s) for @${pollingBot.botInfo.username} because /stop was received in the same polling batch.`);
        }
      } else {
        for (const update of orderedUpdates) {
          const handler = pollingBot.handleUpdates([update]).catch((error) => {
            console.error(`Telegram update ${update.update_id} handler failed for @${pollingBot.botInfo.username}:`, error);
          }).finally(() => {
            activeHandlers.delete(handler);
          });
          activeHandlers.add(handler);
        }
      }
      offset = payload.result[payload.result.length - 1]!.update_id + 1;
    } catch (error) {
      consecutiveFailures += 1;
      const issue = summarizeTelegramTransportError(error);
      const delayMs = Math.max(
        nextPollingBackoffMs(consecutiveFailures, pollingBot.botInfo.username),
        getRetryAfterMs(error) ?? 0,
      );
      const now = Date.now();
      if (consecutiveFailures === 1 || now - lastFailureLogAt >= 60_000) {
        lastFailureLogAt = now;
        console.error(
          `Polling failed for @${pollingBot.botInfo.username}: ${issue}. `
          + `consecutiveFailures=${consecutiveFailures}; nextRetryIn=${formatDuration(delayMs)}.`,
        );
      }
      await writeTelegramTransportStatus(pollingBot.botInfo.username, {
        status: "degraded",
        consecutiveFailures,
        lastIssue: issue,
        lastFailureAt: new Date().toISOString(),
        nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      }).catch((statusError) => {
        console.error(`Failed to write Telegram transport failure status for @${pollingBot.botInfo.username}:`, statusError);
      });
      await sleep(delayMs);
    }
  }
}

type TelegramUpdate = {
  update_id: number;
  message?: { text?: string };
  edited_message?: { text?: string };
  channel_post?: { text?: string };
};

function orderUpdatesForDispatch(updates: TelegramUpdate[]): TelegramUpdate[] {
  return [...updates].sort((left, right) => {
    const leftStop = isStopCommandUpdate(left) ? 0 : 1;
    const rightStop = isStopCommandUpdate(right) ? 0 : 1;
    return leftStop - rightStop || left.update_id - right.update_id;
  });
}

function isStopCommandUpdate(update: TelegramUpdate): boolean {
  const text = update.message?.text ?? update.edited_message?.text ?? update.channel_post?.text ?? "";
  return /^\/stop(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextPollingBackoffMs(failureCount: number, username: string | undefined): number {
  const exponent = Math.max(0, Math.min(failureCount - 1, 10));
  const baseDelay = Math.min(
    config.telegramPollingBackoffMaxMs,
    config.telegramPollingBackoffMinMs * (2 ** exponent),
  );
  return Math.min(config.telegramPollingBackoffMaxMs, baseDelay + stableJitterMs(username));
}

function stableJitterMs(value: string | undefined): number {
  const source = value || "unknown";
  let hash = 0;
  for (const char of source) {
    hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  }
  return hash % 5000;
}

function summarizeTelegramTransportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "").trim()
    : "";
  const combined = [stderr, message].filter(Boolean).join(" ");
  if (/Could not resolve host|Name or service not known|Temporary failure in name resolution/i.test(combined)) {
    return "DNS lookup failed for api.telegram.org";
  }
  if (/timed out|Operation timed out|Connection timed out|code=28/i.test(combined)) {
    return "connection to api.telegram.org timed out";
  }
  if (/SSL_ERROR_SYSCALL|SSL_read|tls/i.test(combined)) {
    return "TLS connection to api.telegram.org failed";
  }
  return combined.split(/\r?\n/, 1)[0]?.slice(0, 300) || "unknown Telegram transport error";
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof TelegramPollingError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return undefined;
}

async function writeTelegramTransportStatus(
  username: string | undefined,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!telegramTransportStatusPath) {
    return;
  }
  const key = username || "unknown_bot";
  telegramTransportStatuses[key] = {
    ...(telegramTransportStatuses[key] ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const next = {
    updatedAt: new Date().toISOString(),
    bots: telegramTransportStatuses,
  };
  await fsp.mkdir(path.dirname(telegramTransportStatusPath), { recursive: true });
  await fsp.writeFile(telegramTransportStatusPath, JSON.stringify(next, null, 2), "utf8");
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
}

async function getUpdatesViaCurl(token: string, offset: number): Promise<{
  ok?: boolean;
  result: TelegramUpdate[];
  description?: string;
}> {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  url.searchParams.set("timeout", String(TELEGRAM_GET_UPDATES_HTTP_TIMEOUT_SECONDS));
  url.searchParams.set("limit", "50");
  if (offset > 0) {
    url.searchParams.set("offset", String(offset));
  }

  const { stdout, stderr } = await execFileAsync("curl", [
    "-sS",
    "-4",
    "--max-time",
    String(TELEGRAM_GET_UPDATES_CURL_TIMEOUT_SECONDS),
    url.toString(),
  ]);

  if (stderr?.trim()) {
    console.error(`curl stderr for getUpdates: ${stderr.trim()}`);
  }

  const payload = JSON.parse(stdout) as {
    ok?: boolean;
    result?: TelegramUpdate[];
    description?: string;
    parameters?: {
      retry_after?: number;
    };
  };

  if (!payload.ok || !Array.isArray(payload.result)) {
    throw new TelegramPollingError(
      payload.description || "getUpdates returned an invalid payload.",
      typeof payload.parameters?.retry_after === "number"
        ? payload.parameters.retry_after * 1000
        : undefined,
    );
  }

  return {
    ok: payload.ok,
    result: payload.result,
    description: payload.description,
  };
}

class TelegramPollingError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TelegramPollingError";
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

function buildBotInfo(token: string, index: number): UserFromGetMe {
  const id = Number.parseInt(token.split(":", 1)[0] ?? "", 10);
  const configuredUsername = config.telegramBotUsernames[index];
  const fallbackUsername = knownBotUsername(id);
  const username = configuredUsername || fallbackUsername || `bot_${Number.isFinite(id) ? id : index + 1}`;

  return {
    id: Number.isFinite(id) ? id : index + 1,
    is_bot: true,
    first_name: username,
    username,
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as UserFromGetMe;
}

function knownBotUsername(id: number): string | undefined {
  if (id === 8369496408) {
    return "codex_remoteagent_bot";
  }
  if (id === 8429712341) {
    return "sqream_bot";
  }
  return undefined;
}

function commandExists(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return fs.existsSync(trimmed);
  }

  if (process.platform === "win32") {
    return spawnSync("where", [trimmed], { stdio: "ignore" }).status === 0;
  }

  return spawnSync("sh", ["-lc", 'command -v "$0" >/dev/null 2>&1', trimmed], { stdio: "ignore" }).status === 0;
}


async function acquireProcessLock(dataDir: string): Promise<string> {
  await fsp.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "remoteagent.lock");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return lockPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      const existingPid = Number.parseInt((await fsp.readFile(lockPath, "utf8").catch(() => "")).trim(), 10);
      if (!Number.isFinite(existingPid) || !isProcessAlive(existingPid)) {
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }

      throw new Error(`RemoteAgent is already running with PID ${existingPid}.`);
    }
  }

  throw new Error("RemoteAgent could not acquire its process lock.");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function registerProcessLifecycle(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    releaseProcessLockSync();
    process.exit(1);
  });

  process.once("SIGINT", () => {
    console.error("Received SIGINT, shutting down RemoteAgent.");
    releaseProcessLockSync();
    process.exit(0);
  });

  process.once("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down RemoteAgent.");
    releaseProcessLockSync();
    process.exit(0);
  });

  process.once("exit", () => {
    releaseProcessLockSync();
  });
}

function releaseProcessLockSync(): void {
  if (!processLockPath) {
    return;
  }

  try {
    const recordedPid = fs.readFileSync(processLockPath, "utf8").trim();
    if (recordedPid === String(process.pid)) {
      fs.rmSync(processLockPath, { force: true });
    }
  } catch {
    // Ignore best-effort cleanup errors.
  }
}
