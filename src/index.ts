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
import { AgentMemoryService } from "./services/agent-memory-service.js";
import { BotPollingStateService } from "./services/bot-polling-state-service.js";
import type { BotPollingState } from "./services/bot-polling-state-service.js";
import { computePolicyPollIntervalMs, computeRecentMessageRanks } from "./services/polling-policy.js";
import { terminateAllSpawnedExecutions } from "./adapters/windows-shell.js";
import { setTelegramCommandMenu } from "./telegram-command-menu.js";
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
let botPollingState: BotPollingStateService;

async function main(): Promise<void> {
  processLockPath = await acquireProcessLock(config.dataDir);
  telegramTransportStatusPath = path.join(config.dataDir, "telegram-transport.json");
  telegramPollingLimiter = new AsyncSemaphore(config.telegramPollingMaxConcurrency);
  botPollingState = new BotPollingStateService(config.dataDir);
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
    botPollingState,
  );
  startArtifactCleanupSchedule(new AgentMemoryService(config.dataDir));
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

  const botInfos = await Promise.all(config.telegramBotTokens.map((token, index) => resolveBotInfo(token, index)));
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

  await startManualPollingScheduler(bots);
}

function startArtifactCleanupSchedule(memoryService: AgentMemoryService): void {
  if (!config.artifactCleanupEnabled) {
    console.log("Artifact cleanup schedule is disabled.");
    return;
  }

  const run = async (): Promise<void> => {
    try {
      const result = await memoryService.cleanupArtifacts(config.artifactRetentionDays);
      console.log(`[artifact-cleanup] ${result}`);
    } catch (error) {
      console.error("[artifact-cleanup] failed:", error);
    }
  };

  console.log(
    `Artifact cleanup schedule enabled: retention=${config.artifactRetentionDays}d interval=${config.artifactCleanupIntervalMs}ms`,
  );
  const initial = setTimeout(() => {
    void run();
  }, 60_000);
  initial.unref();

  const interval = setInterval(() => {
    void run();
  }, config.artifactCleanupIntervalMs);
  interval.unref();
}

async function configureTelegramCommandMenu(bot: Bot): Promise<void> {
  const token = (bot as unknown as { token?: string }).token;
  if (!token) {
    throw new Error("Telegram bot token is unavailable for command menu registration.");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await setTelegramCommandMenu(token);
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

main().catch((error: unknown) => {
  console.error("RemoteAgent fatal error:", error);
  releaseProcessLockSync();
  process.exitCode = 1;
});

type PollingBot = {
  token: string;
  handleUpdates(updates: TelegramUpdate[]): Promise<void>;
  botInfo: { id: number; username?: string };
};

type PollingRuntimeState = {
  offset: number;
  inFlight: boolean;
  consecutiveFailures: number;
  lastFailureLogAt: number;
};

async function startManualPollingScheduler(bots: Bot[]): Promise<never> {
  const pollingBots = bots as unknown as PollingBot[];
  const runtimeStates = new Map<string, PollingRuntimeState>();
  const botIds = pollingBots.map((bot) => String(bot.botInfo.id));
  await botPollingState.prune(botIds);

  for (const [index, bot] of pollingBots.entries()) {
    const botId = String(bot.botInfo.id);
    runtimeStates.set(botId, {
      offset: 0,
      inFlight: false,
      consecutiveFailures: 0,
      lastFailureLogAt: 0,
    });
    const initialDelayMs = Math.min(30_000, index * 3_000 + stableJitterMs(bot.botInfo.username));
    await botPollingState.recordPoll(botId, {
      username: bot.botInfo.username,
      nextPollAt: new Date(Date.now() + initialDelayMs).toISOString(),
    });
    console.log(`Scheduled polling for @${bot.botInfo.username} in ${formatDuration(initialDelayMs)}.`);
  }

  while (true) {
    const now = Date.now();
    let activePolls = [...runtimeStates.values()].filter((state) => state.inFlight).length;
    const pollingStates = await botPollingState.list();
    const rankByBotId = computeRecentMessageRanks(botIds, pollingStates);
    for (const bot of pollingBots) {
      if (activePolls >= config.telegramPollingMaxConcurrency) {
        break;
      }
      const botId = String(bot.botInfo.id);
      const runtime = runtimeStates.get(botId);
      if (!runtime || runtime.inFlight) {
        continue;
      }
      const state = await botPollingState.get(botId, bot.botInfo.username);
      const nextPollAt = state.nextPollAt ? Date.parse(state.nextPollAt) : 0;
      if (Number.isFinite(nextPollAt) && nextPollAt > now) {
        continue;
      }

      runtime.inFlight = true;
      activePolls += 1;
      void pollTelegramBot(bot, runtime, {
        totalBots: pollingBots.length,
        botRank: rankByBotId.get(botId) ?? pollingBots.length,
        state,
      }).finally(() => {
        runtime.inFlight = false;
      });
    }
    await sleep(config.telegramSchedulerTickMs);
  }
}

async function pollTelegramBot(
  pollingBot: PollingBot,
  runtime: PollingRuntimeState,
  options: { totalBots: number; botRank: number; state?: BotPollingState },
): Promise<void> {
  const botId = String(pollingBot.botInfo.id);
  try {
    const payload = await telegramPollingLimiter.run(() => getUpdatesViaCurl(pollingBot.token, runtime.offset));
    if (runtime.consecutiveFailures > 0) {
      console.warn(`Telegram polling recovered for @${pollingBot.botInfo.username} after ${runtime.consecutiveFailures} failure(s).`);
      await writeTelegramTransportStatus(pollingBot.botInfo.username, {
        status: "ok",
        consecutiveFailures: 0,
        lastRecoveredAt: new Date().toISOString(),
      }).catch((error) => {
        console.error(`Failed to write Telegram transport recovery status for @${pollingBot.botInfo.username}:`, error);
      });
      runtime.consecutiveFailures = 0;
      runtime.lastFailureLogAt = 0;
    }

    const now = Date.now();
    const orderedUpdates = orderUpdatesForDispatch(payload.result);
    if (orderedUpdates.length > 0) {
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
          void pollingBot.handleUpdates([update]).catch((error) => {
            console.error(`Telegram update ${update.update_id} handler failed for @${pollingBot.botInfo.username}:`, error);
          });
        }
      }
      runtime.offset = orderedUpdates[orderedUpdates.length - 1]!.update_id + 1;
    }

    const receivedMessage = orderedUpdates.some(hasMessagePayload);
    const lastMessageAt = receivedMessage ? new Date(now).toISOString() : options.state?.lastMessageAt;
    const nextPollAt = now + computePolicyPollIntervalMs(options.totalBots, receivedMessage ? 1 : options.botRank, {
      ...options.state,
      botId,
      consecutiveFailures: options.state?.consecutiveFailures ?? runtime.consecutiveFailures,
      lastMessageAt,
    }, {
      tieredPollingMinBots: config.telegramTieredPollingMinBots,
      activePollIntervalMs: config.telegramActivePollIntervalMs,
      runningPollIntervalMs: config.telegramRunningPollIntervalMs,
      secondaryPollIntervalMs: config.telegramSecondaryPollIntervalMs,
      tertiaryPollIntervalMs: config.telegramTertiaryPollIntervalMs,
    });
    await botPollingState.recordPoll(botId, {
      username: pollingBot.botInfo.username,
      lastPollAt: new Date(now).toISOString(),
      lastUpdateAt: orderedUpdates.length > 0 ? new Date(now).toISOString() : undefined,
      lastMessageAt,
      nextPollAt: new Date(nextPollAt).toISOString(),
      consecutiveFailures: 0,
    });
  } catch (error) {
    runtime.consecutiveFailures += 1;
    const issue = summarizeTelegramTransportError(error);
    const delayMs = Math.max(
      nextPollingBackoffMs(runtime.consecutiveFailures, pollingBot.botInfo.username),
      getRetryAfterMs(error) ?? 0,
    );
    const now = Date.now();
    if (runtime.consecutiveFailures === 1 || now - runtime.lastFailureLogAt >= 60_000) {
      runtime.lastFailureLogAt = now;
      console.error(
        `Polling failed for @${pollingBot.botInfo.username}: ${issue}. `
        + `consecutiveFailures=${runtime.consecutiveFailures}; nextRetryIn=${formatDuration(delayMs)}.`,
      );
    }
    await writeTelegramTransportStatus(pollingBot.botInfo.username, {
      status: "degraded",
      consecutiveFailures: runtime.consecutiveFailures,
      lastIssue: issue,
      lastFailureAt: new Date().toISOString(),
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
    }).catch((statusError) => {
      console.error(`Failed to write Telegram transport failure status for @${pollingBot.botInfo.username}:`, statusError);
    });
    await botPollingState.recordPoll(botId, {
      username: pollingBot.botInfo.username,
      consecutiveFailures: runtime.consecutiveFailures,
      lastPollAt: new Date(now).toISOString(),
      nextPollAt: new Date(now + delayMs).toISOString(),
    });
  }
}

function hasMessagePayload(update: TelegramUpdate): boolean {
  return Boolean(update.message || update.edited_message || update.channel_post);
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

type TelegramGetMeResponse = {
  ok?: boolean;
  description?: string;
  result?: {
    id?: number;
    username?: string;
    first_name?: string;
  };
};

async function resolveBotInfo(token: string, index: number): Promise<UserFromGetMe> {
  try {
    const { stdout } = await execFileAsync("curl", [
      "-sS",
      "-4",
      "--max-time",
      "10",
      `https://api.telegram.org/bot${token}/getMe`,
    ]);
    const payload = JSON.parse(stdout) as TelegramGetMeResponse;
    if (payload.ok && payload.result?.id && payload.result.username) {
      return buildBotInfoFromIdentity(payload.result.id, payload.result.username, payload.result.first_name);
    }
    console.warn(`Telegram getMe failed for bot ${tokenIdLabel(token)}: ${payload.description || "missing bot identity"}`);
  } catch (error) {
    console.warn(`Telegram getMe failed for bot ${tokenIdLabel(token)}: ${summarizeTelegramIdentityError(error)}`);
  }

  return buildFallbackBotInfo(token, index);
}

function buildBotInfoFromIdentity(id: number, username: string, firstName?: string): UserFromGetMe {
  return {
    id,
    is_bot: true,
    first_name: firstName || username,
    username,
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as UserFromGetMe;
}

function buildFallbackBotInfo(token: string, index: number): UserFromGetMe {
  const id = Number.parseInt(token.split(":", 1)[0] ?? "", 10);
  const fallbackUsername = knownBotUsername(id);
  const username = fallbackUsername || `bot_${Number.isFinite(id) ? id : index + 1}`;

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

function tokenIdLabel(token: string): string {
  return token.split(":", 1)[0] || "unknown";
}

function summarizeTelegramIdentityError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return [code, error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")]
    .filter(Boolean)
    .join(" ");
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
    stopActiveProviderExecutionsForShutdown();
    releaseProcessLockSync();
    process.exit(0);
  });

  process.once("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down RemoteAgent.");
    stopActiveProviderExecutionsForShutdown();
    releaseProcessLockSync();
    process.exit(0);
  });

  process.once("exit", () => {
    releaseProcessLockSync();
  });
}

function stopActiveProviderExecutionsForShutdown(): void {
  const stopped = terminateAllSpawnedExecutions();
  if (stopped > 0) {
    console.error(`Stopped ${stopped} active provider execution(s) during RemoteAgent shutdown.`);
  }
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
