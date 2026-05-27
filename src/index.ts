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
let processLockPath: string | undefined;

async function main(): Promise<void> {
  processLockPath = await acquireProcessLock(config.dataDir);
  registerProcessLifecycle();

  const store = new FileStore(config.dataDir, config.defaultMode);
  await store.init();

  const adapters: Partial<Record<Provider, ProviderAdapter>> = {
    codex: config.commands.codex
      ? new ShellAdapter("codex", config.commands.codex, config.commandTimeoutMs)
      : new CodexAdapter(
        config.codexBin,
        config.commandTimeoutMs,
        config.codexSandboxMode,
      ),
    claude: config.commands.claude
      ? new ShellAdapter("claude", config.commands.claude, config.commandTimeoutMs)
      : new ClaudeAdapter(
        config.claudeBin,
        config.commandTimeoutMs,
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

  for (const bot of bots) {
    const username = bot.botInfo.username;
    console.log(`Bot @${username} is ready`);
  }

  await botManagement.reportPendingOperationResult().catch((error) => {
    console.error("Failed to report pending bot operation result:", error);
  });

  await Promise.all(bots.map((bot) => startManualPolling(bot)));
}

main().catch((error: unknown) => {
  console.error("RemoteAgent fatal error:", error);
  releaseProcessLockSync();
  process.exitCode = 1;
});

async function startManualPolling(bot: Bot): Promise<never> {
  const pollingBot = bot as unknown as {
    token: string;
    handleUpdates(updates: unknown[]): Promise<void>;
    botInfo: { username?: string };
  };
  let offset = 0;
  let consecutiveFailures = 0;
  let firstFailureAt: number | undefined;
  let lastFailureAt: number | undefined;
  let lastIssue = "unknown error";
  let lastAlertAttemptAt = 0;

  while (true) {
    try {
      const payload = await getUpdatesViaCurl(pollingBot.token, offset);
      if (consecutiveFailures > 0) {
        await notifyPollingRecoveryIfNeeded(
          pollingBot.token,
          pollingBot.botInfo.username,
          consecutiveFailures,
          firstFailureAt,
          lastFailureAt,
          lastIssue,
        ).catch(() => undefined);
        consecutiveFailures = 0;
        firstFailureAt = undefined;
        lastFailureAt = undefined;
        lastIssue = "unknown error";
        lastAlertAttemptAt = 0;
      }

      if (payload.result.length === 0) {
        continue;
      }

      await pollingBot.handleUpdates(payload.result);
      offset = payload.result[payload.result.length - 1]!.update_id + 1;
    } catch (error) {
      const issue = classifyTelegramPollingError(error);
      consecutiveFailures += 1;
      const now = Date.now();
      firstFailureAt ??= now;
      lastFailureAt = now;
      lastIssue = issue.summary;
      console.error(`Polling failed for @${pollingBot.botInfo.username}:`, error);

      if (
        config.telegramOwnerId
        && consecutiveFailures >= 3
        && now - lastAlertAttemptAt >= 60_000
      ) {
        lastAlertAttemptAt = now;
        await notifyPollingFailure(
          pollingBot.token,
          pollingBot.botInfo.username,
          consecutiveFailures,
          firstFailureAt,
          issue.summary,
        ).catch(() => undefined);
      }

      await sleep(nextPollingRetryDelayMs(consecutiveFailures, issue.kind));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getUpdatesViaCurl(token: string, offset: number): Promise<{
  ok?: boolean;
  result: Array<{ update_id: number }>;
  description?: string;
}> {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  url.searchParams.set("timeout", "30");
  url.searchParams.set("limit", "50");
  if (offset > 0) {
    url.searchParams.set("offset", String(offset));
  }

  const { stdout, stderr } = await execFileAsync("curl", [
    "-sS",
    "--max-time",
    "35",
    url.toString(),
  ]);

  if (stderr?.trim()) {
    console.error(`curl stderr for getUpdates: ${stderr.trim()}`);
  }

  const payload = JSON.parse(stdout) as {
    ok?: boolean;
    result?: Array<{ update_id: number }>;
    description?: string;
  };

  if (!payload.ok || !Array.isArray(payload.result)) {
    throw new Error(payload.description || "getUpdates returned an invalid payload.");
  }

  return {
    ok: payload.ok,
    result: payload.result,
    description: payload.description,
  };
}

type TelegramPollingIssueKind = "dns" | "timeout" | "ssl" | "http" | "unknown";

function classifyTelegramPollingError(error: unknown): {
  kind: TelegramPollingIssueKind;
  summary: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "")
    : "";
  const combined = `${message}\n${stderr}`;

  if (/Could not resolve host|Name or service not known|Temporary failure in name resolution/i.test(combined)) {
    return {
      kind: "dns",
      summary: "DNS lookup failed for api.telegram.org.",
    };
  }

  if (/timed out|Operation timed out|Connection timed out/i.test(combined)) {
    return {
      kind: "timeout",
      summary: "Telegram polling timed out while waiting for api.telegram.org.",
    };
  }

  if (/SSL_ERROR_SYSCALL|SSL_read|tls/i.test(combined)) {
    return {
      kind: "ssl",
      summary: "Telegram polling hit an SSL/TLS read error.",
    };
  }

  if (/HTTP|status/i.test(combined)) {
    return {
      kind: "http",
      summary: "Telegram polling failed with an HTTP/API error.",
    };
  }

  return {
    kind: "unknown",
    summary: "Telegram polling failed with an unknown transport error.",
  };
}

function nextPollingRetryDelayMs(failureCount: number, kind: TelegramPollingIssueKind): number {
  const base = kind === "dns" ? 5_000 : 2_000;
  return Math.min(30_000, base * Math.max(1, Math.min(failureCount, 6)));
}

async function notifyPollingFailure(
  token: string,
  username: string | undefined,
  consecutiveFailures: number,
  firstFailureAt: number | undefined,
  issue: string,
): Promise<void> {
  if (!config.telegramOwnerId) {
    return;
  }

  const lines = [
    `RemoteAgent polling warning for @${username ?? "unknown_bot"}`,
    issue,
    `consecutiveFailures: ${consecutiveFailures}`,
    firstFailureAt ? `since: ${new Date(firstFailureAt).toISOString()}` : undefined,
    "Automatic retries are still running in the background.",
  ].filter(Boolean);

  await sendTelegramControlMessage(token, config.telegramOwnerId, lines.join("\n"));
}

async function notifyPollingRecoveryIfNeeded(
  token: string,
  username: string | undefined,
  consecutiveFailures: number,
  firstFailureAt: number | undefined,
  lastFailureAt: number | undefined,
  issue: string,
): Promise<void> {
  if (!config.telegramOwnerId || consecutiveFailures < 3) {
    return;
  }

  const durationMs = firstFailureAt && lastFailureAt
    ? Math.max(0, lastFailureAt - firstFailureAt)
    : undefined;

  const lines = [
    `RemoteAgent polling recovered for @${username ?? "unknown_bot"}`,
    `lastIssue: ${issue}`,
    `consecutiveFailures: ${consecutiveFailures}`,
    durationMs !== undefined ? `downtime: ${formatDuration(durationMs)}` : undefined,
  ].filter(Boolean);

  await sendTelegramControlMessage(token, config.telegramOwnerId, lines.join("\n"));
}

async function sendTelegramControlMessage(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const { stdout, stderr } = await execFileAsync("curl", [
    "-sS",
    "--max-time",
    "20",
    url,
    "--data-urlencode",
    `chat_id=${chatId}`,
    "--data-urlencode",
    `text=${text}`,
  ]);

  if (stderr?.trim()) {
    console.error(`curl stderr for polling alert sendMessage: ${stderr.trim()}`);
  }

  const payload = JSON.parse(stdout) as { ok?: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(payload.description || "Polling alert sendMessage failed.");
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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
