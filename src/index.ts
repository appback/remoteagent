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
import { DotBridgeService } from "./services/dot-bridge-service.js";
import { DotMcpService, createDotAuthenticator } from "./services/dot-mcp-service.js";
import { readG2Clients, type G2Client } from "./services/g2-config.js";
import { G2RequestService } from "./services/g2-request-service.js";
import { G2ApiService } from "./services/g2-api-service.js";
import { G2ServerService } from "./services/g2-server-service.js";
import { G2SpeechService } from "./services/g2-speech-service.js";
import type { G2PairingControl } from "./services/dot-owner-auth-service.js";
import { acquireProcessLock, releaseProcessLock } from "./services/runtime-lock.js";
import { DotHostService } from "./services/dot-host-service.js";
import type { DotMacService } from "./services/dot-mac-service.js";
import { createDotWebhookPost } from "./services/dot-webhook.js";
import { AgentMemoryService } from "./services/agent-memory-service.js";
import { WorkspaceCleanupService } from "./services/workspace-cleanup-service.js";
import { BotPollingStateService } from "./services/bot-polling-state-service.js";
import type { BotPollingState } from "./services/bot-polling-state-service.js";
import { ProviderRecoveryService } from "./services/provider-recovery-service.js";
import { computePolicyPollIntervalMs, computeRecentMessageRanks } from "./services/polling-policy.js";
import { terminateAllSpawnedExecutions } from "./adapters/windows-shell.js";
import { buildProviderEnv } from "./adapters/runtime-env.js";
import { buildBotInfoFromIdentity, buildFallbackBotInfo } from "./telegram-bot-identity.js";
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
  startWorkspaceCleanupSchedule(new WorkspaceCleanupService(config.dataDir, config.workspaceRoot));
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

  let dot: DotBridgeService | undefined;
  let g2Login: (() => { code: string; expiresAt: string }) | undefined;
  let g2Pairing: G2PairingControl | undefined;
  if (!config.dotEnabled && process.env.G2_API_ENABLED === "true") {
    const resource = process.env.G2_PUBLIC_URL?.trim();
    const owner = config.telegramOwnerId?.trim();
    if (!resource || !/^\d+$/.test(owner ?? "")) throw Error("G2_PUBLIC_URL and TELEGRAM_OWNER_ID are required");
    const clients = readG2Clients(process.env.G2_OAUTH_CONFIG_FILE);
    const auth = new (await import("./services/dot-owner-auth-service.js")).DotOwnerAuthService(config.dataDir, resource, `telegram:${owner}`, clients, false);
    const requests = new G2RequestService(config.dataDir, auth.owner, bridge);
    await requests.restore();
    let speech: G2SpeechService | undefined;
    if (process.env.G2_WHISPER_BIN && process.env.G2_WHISPER_MODEL) {
      try {
        speech = new G2SpeechService(process.env.G2_WHISPER_BIN, process.env.G2_WHISPER_MODEL);
        await speech.ready();
      } catch { speech = undefined; console.error("G2 speech unavailable: check the configured local decoder and model. Telegram and text requests remain available."); }
    }
    const api = new G2ApiService(requests, resource, clients, auth.authenticateG2.bind(auth), speech);
    const port = Number(process.env.G2_HTTP_PORT ?? "3796");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid G2_HTTP_PORT");
    await new G2ServerService(auth.handle.bind(auth), api.handle.bind(api)).start(port);
    g2Login = () => auth.issueLoginCode();
    g2Pairing = {
      async preview(code) {
        const approval = await auth.previewG2Device(code), inventory = await requests.inventory();
        return { clientId: approval.clientId, targetLabels: approval.targetIds.map(id => inventory.find(t => t.targetId === id)?.label ?? "대상 없음") };
      },
      decide: auth.decideG2Device.bind(auth),
    };
    console.log(`G2 API listening on 127.0.0.1:${port}; dot is disabled.`);
  }
  if (config.dotEnabled) {
    try {
      const required = (name: string): string => {
        const value = process.env[name]?.trim();
        if (!value) throw Error(`Missing ${name}`);
        return value;
      };
      const managed = process.env.DOT_AUTH_MODE?.trim() !== "external" && !process.env.DOT_OAUTH_ISSUER?.trim();
      const owner = config.telegramOwnerId?.trim();
      if (managed && !/^\d+$/.test(owner ?? "")) throw Error("Missing DOT_TELEGRAM_OWNER");
      const resource = required("DOT_PUBLIC_URL");
      let g2Clients: G2Client[] = [];
      if (process.env.G2_API_ENABLED === "true") {
        try {
          if (!managed) throw Error("G2_MANAGED_OAUTH_REQUIRED");
          g2Clients = readG2Clients(process.env.G2_OAUTH_CONFIG_FILE);
        } catch { console.error("G2 API disabled: confirm the operator-approved G2 OAuth configuration. Existing dot/Telegram routing is unchanged."); }
      }
      const auth = managed ? new (await import("./services/dot-owner-auth-service.js")).DotOwnerAuthService(config.dataDir, resource, `telegram:${owner}`, g2Clients) : undefined;
      const oauth = auth ? { resource, issuer: auth.issuer, subject: auth.owner } : {
        resource, issuer: required("DOT_OAUTH_ISSUER"),
        introspectionUrl: required("DOT_OAUTH_INTROSPECTION_URL"), clientId: required("DOT_OAUTH_CLIENT_ID"),
        clientSecret: required("DOT_OAUTH_CLIENT_SECRET"), subject: required("DOT_OAUTH_SUBJECT"),
      };
      const authenticate = auth ? auth.authenticate.bind(auth) : createDotAuthenticator(oauth as Parameters<typeof createDotAuthenticator>[0]);
      const hosts = process.env.DOT_CALLBACK_HOSTS?.trim();
      const candidate = new DotBridgeService(config.dataDir, oauth.subject,
        createDotWebhookPost(hosts ? hosts.split(",") : managed ? undefined : required("DOT_CALLBACK_HOSTS").split(",")), Date.now,
        async header => (await authenticate(header))?.subject);
      if (auth) candidate.setLoginCodeIssuer(() => auth.issueLoginCode());
      let g2Api: G2ApiService | undefined;
      if (auth && g2Clients.length) {
        try {
          const requests = new G2RequestService(config.dataDir, oauth.subject, bridge, candidate);
          await requests.restore();
          g2Api = new G2ApiService(requests, resource, g2Clients, auth.authenticateG2.bind(auth));
        } catch {
          candidate.clearExternalReporter();
          console.error("G2 API disabled: request storage/recovery failed. Existing Telegram/dot routing remains available.");
        }
      }
      let host: DotHostService | undefined;
      if (process.env.DOT_HOST_ENABLED === "true") {
        try { host = new DotHostService(config.dataDir, JSON.parse(process.env.DOT_HOST_ROOTS ?? "[]") as string[]); }
        catch { console.error("Dot host execution disabled: check DOT_HOST_ROOTS (existing absolute directories, JSON array)."); }
      }
      let mac: DotMacService | undefined;
      if (process.env.DOT_MAC_ENABLED === "true" && process.platform === "darwin") {
        try {
          const screen = process.env.DOT_MAC_SCREEN_BACKEND === "native"
            ? new (await import("./services/dot-mac-screen-service.js")).DotMacScreenService() : undefined;
          mac = new (await import("./services/dot-mac-service.js")).DotMacService(config.dataDir, required("DOT_MAC_BINARY"), process.env.DOT_MAC_BRIDGE_SOCKET?.trim() || undefined, process.env.DOT_MAC_FOREGROUND === "true", [], screen);
        }
        catch { console.error("Dot Mac tools disabled: check Peekaboo binary and private operation storage."); }
      }
      if (host || mac) candidate.setHostCancellation(requestId => {
        host?.cancelRequest(requestId);
        mac?.cancelRequest(requestId);
      });
      const mcp = new DotMcpService(candidate, "127.0.0.1", config.dotPort, oauth, authenticate, auth?.handle.bind(auth), host, mac, g2Api?.handle.bind(g2Api));
      try { await mcp.start(); } catch (error) { host?.close(); await mac?.close(); throw error; }
      if (g2Api && auth) g2Login = () => auth.issueLoginCode();
      candidate.start();
      dot = candidate;
      console.log(`Dot MCP bridge listening on 127.0.0.1:${config.dotPort}; real dot linking must be verified separately.`);
    } catch (error) {
      console.error("Dot bridge was not enabled; existing providers are unchanged.",
        error instanceof Error && error.message.startsWith("Missing DOT_") ? error.message : "Check Dot OAuth/port configuration.");
    }
  }
  if (config.dotEnabled && !dot && fs.existsSync(path.join(config.dataDir, "dot", "bridge.json"))) {
    // Keep explicit dot chat bindings paused on configuration failure, never silently route them to Codex.
    dot = new DotBridgeService(config.dataDir, process.env.DOT_OAUTH_SUBJECT?.trim() ?? "",
      async () => { throw Error("DOT_CONFIGURATION_UNAVAILABLE"); });
    dot.pause();
  }

  const botInfos = await Promise.all(config.telegramBotTokens.map((token, index) =>
    resolveBotInfo(token, index, config.telegramBotUsernames[index])
  ));
  const bots = config.telegramBotTokens.map((token, index) => createBot(token, bridge, botManagement, botInfos[index]!, dot, g2Login, g2Pairing));

  if (!config.telegramCommandMenuEnabled) {
    console.log("Telegram command menu registration is disabled.");
  } else {
    console.log("Telegram command menu startup refresh is skipped; use /option command-menu refresh to apply changes.");
  }
  for (const bot of bots) {
    console.log(`Bot @${bot.botInfo.username} is ready`);
  }

  await botManagement.reportPendingOperationResult().catch((error) => {
    console.error("Failed to report pending bot operation result:", error);
  });

  await startManualPollingScheduler(bots);
}

function startWorkspaceCleanupSchedule(workspaceCleanupService: WorkspaceCleanupService): void {
  if (!config.workspaceCleanupEnabled) {
    console.log("Workspace cleanup schedule is disabled.");
    return;
  }

  const run = async (): Promise<void> => {
    try {
      const result = await workspaceCleanupService.cleanupOrphanWorkspaces();
      console.log(`[workspace-cleanup] ${result}`);
    } catch (error) {
      console.error("[workspace-cleanup] failed:", error);
    }
  };

  console.log(`Workspace cleanup schedule enabled: interval=${config.workspaceCleanupIntervalMs}ms`);
  const initial = setTimeout(() => {
    void run();
  }, 120_000);
  initial.unref();

  const interval = setInterval(() => {
    void run();
  }, config.workspaceCleanupIntervalMs);
  interval.unref();
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
  const providerRecovery = new ProviderRecoveryService(config.dataDir, botPollingState);
  let nextRecoveryCheckAt = 0;
  let recoveryCheckInFlight = false;
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
    if (!recoveryCheckInFlight && now >= nextRecoveryCheckAt) {
      recoveryCheckInFlight = true;
      nextRecoveryCheckAt = now + config.telegramRecoveryCheckIntervalMs;
      void providerRecovery.reconcileStaleRunningStates(pollingBots.map((bot) => ({
        botId: String(bot.botInfo.id),
        username: bot.botInfo.username,
        token: bot.token,
      }))).then((result) => {
        if (result.recovered > 0) {
          console.warn(`[provider-recovery] cleared ${result.recovered} stale running session(s) after checking ${result.checked}.`);
        }
      }).catch((error) => {
        console.error("[provider-recovery] reconciliation failed:", error);
      }).finally(() => {
        recoveryCheckInFlight = false;
      });
    }

    let activePolls = [...runtimeStates.values()].filter((state) => state.inFlight).length;
    const pollingStates = await botPollingState.list();
    const rankByBotId = computeRecentMessageRanks(botIds, pollingStates);
    const dueBots = pollingBots
      .map((bot) => {
        const botId = String(bot.botInfo.id);
        const runtime = runtimeStates.get(botId);
        const state = pollingStates[botId];
        const nextPollAt = state?.nextPollAt ? Date.parse(state.nextPollAt) : 0;
        return {
          bot,
          botId,
          runtime,
          state,
          rank: rankByBotId.get(botId) ?? pollingBots.length,
          nextPollAt: Number.isFinite(nextPollAt) ? nextPollAt : 0,
        };
      })
      .filter((entry) => entry.runtime && !entry.runtime.inFlight && entry.nextPollAt <= now)
      .sort((left, right) => left.nextPollAt - right.nextPollAt || left.rank - right.rank);

    for (const entry of dueBots) {
      if (activePolls >= config.telegramPollingMaxConcurrency) {
        break;
      }

      entry.runtime!.inFlight = true;
      activePolls += 1;
      void pollTelegramBot(entry.bot, entry.runtime!, {
        totalBots: pollingBots.length,
        botRank: entry.rank,
        state: entry.state,
      }).finally(() => {
        entry.runtime!.inFlight = false;
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
    const lastUserMessageAt = receivedMessage ? new Date(now).toISOString() : options.state?.lastUserMessageAt;
    const lastMessageAt = receivedMessage ? lastUserMessageAt : options.state?.lastMessageAt;
    const nextPollAt = now + computePolicyPollIntervalMs(options.totalBots, receivedMessage ? 1 : options.botRank, {
      ...options.state,
      botId,
      consecutiveFailures: options.state?.consecutiveFailures ?? runtime.consecutiveFailures,
      lastUserMessageAt,
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
      lastUserMessageAt,
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
  const message = update.message || update.edited_message || update.channel_post;
  return Boolean(message && !message.from?.is_bot);
}

type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; from?: { is_bot?: boolean } };
  edited_message?: { text?: string; from?: { is_bot?: boolean } };
  channel_post?: { text?: string; from?: { is_bot?: boolean } };
};

function orderUpdatesForDispatch(updates: TelegramUpdate[]): TelegramUpdate[] {
  return [...updates].sort((left, right) => {
    const leftStop = isStopCommandUpdate(left) ? 0 : 1;
    const rightStop = isStopCommandUpdate(right) ? 0 : 1;
    return leftStop - rightStop || left.update_id - right.update_id;
  });
}

function isStopCommandUpdate(update: TelegramUpdate): boolean {
  if ((update.message || update.edited_message || update.channel_post)?.from?.is_bot) return false;
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
  // Telegram retains this filter across clients, including CLI owner registration.
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "edited_message", "channel_post", "callback_query"]));
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

async function resolveBotInfo(token: string, index: number, configuredUsername?: string): Promise<UserFromGetMe> {
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

  return buildFallbackBotInfo(token, index, configuredUsername);
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

function commandExists(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return fs.existsSync(trimmed);
  }

  if (process.platform === "win32") {
    return spawnSync("where", [trimmed], { stdio: "ignore", env: buildProviderEnv() }).status === 0;
  }

  return spawnSync("sh", ["-lc", 'command -v "$0" >/dev/null 2>&1', trimmed], {
    stdio: "ignore",
    env: buildProviderEnv(),
  }).status === 0;
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

  releaseProcessLock(processLockPath);
}
