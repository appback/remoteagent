import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { config } from "./config.js";
import { BridgeService } from "./services/bridge-service.js";
import { BotManagementService } from "./services/bot-management-service.js";
import { ProviderSetupService } from "./services/provider-setup-service.js";
import { RemoteShellService } from "./services/remote-shell-service.js";
import { AgentMemoryService } from "./services/agent-memory-service.js";
import { deleteTelegramCommandMenu, setTelegramCommandMenu } from "./telegram-command-menu.js";
import type { ChatSession, CodexSandboxMode, Provider } from "./types.js";
import type { UserFromGetMe } from "grammy/types";

const execFileAsync = promisify(execFile);

const HELP_TEXT = [
  "Commands:",
  "/start [codex|claude]",
  "/help",
  "/list [-a]",
  "/new",
  "/switch <session>",
  "/batch start|send|cancel|status",
  "/attach codex <thread_id>",
  "/attach claude <session_id>",
  "/model [name]",
  "/stop",
  "/sandbox codex <read-only|workspace-write|danger-full-access>",
  "/status",
  "/option [retry <count>|timeout <seconds>|intent <count>|command-menu <on|off|refresh>]",
  "/state [clear|note <text>]",
  "/artifacts list|cleanup <days>",
  "/secret set|list|remove",
  "/docs pin|find|list|remove",
  "/bots",
  "/bot add <token>",
  "/bot doctor",
  "/bot main <number|@username|id>",
  "/bot remove <username|id>",
  "/bot reload",
  "/install codex|claude",
  "/login codex",
  "/login claude [token]",
  "/reset",
  "/! <command>",
  "/!cmd <command>",
  "/!bash <command>",
].join("\n");

const REPORT_PREFIX = "REPORT:";
const REPORT_PROTOCOL_PROMPT = [
  "RemoteAgent execution protocol:",
  "Start the first line of every reply with exactly one of:",
  "REPORT:progress",
  "REPORT:result",
  "REPORT:blocked",
  "Use REPORT:progress only after you completed a real chunk of work and will continue automatically.",
  "Use REPORT:result only when the requested work for this turn is actually finished.",
  "Use REPORT:blocked only when you cannot continue without user input or an external fix.",
  "If you are waiting on sudo, login, permission changes, API keys, SSH access, or any manual user/admin step, you must use REPORT:blocked.",
  "Do not say 'I will continue' or 'I can continue after you do X' unless the first line is REPORT:blocked.",
  "After the first line, write only the user-facing report.",
  "Do not stop at intent like 'I will' or 'I am going to'. Do the work first, then report progress/result, or report blocked.",
  "If REPORT:result claims code, DB, deploy, commit, push, file delivery, or verification work is complete, include concrete evidence such as file paths, commands, logs, commit IDs, digests, or line references.",
  "RemoteAgent owns conversational delivery: return text normally and RemoteAgent sends it to the current incoming chat.",
  "RemoteAgent owns attachment delivery: include a separate line exactly like `TELEGRAM_FILE: /absolute/path/to/file` and RemoteAgent sends that file to the current incoming chat.",
  "Product/service Telegram notifications are product code behavior; use the project's secret/config path and keep tokens out of output.",
  "Use project secrets or `node \"$REMOTEAGENT_SECRET_BIN\" get <KEY>` for sensitive runtime values, and never print secret values.",
  "REMOTEAGENT_SESSION_ID and REMOTEAGENT_PUBLIC_SESSION_ID are available during provider execution. For cron, persist the literal public session id in the cron command instead of assuming the env will still exist later.",
].join("\n");
const RECOGNIZED_COMMANDS = new Set([
  "start",
  "help",
  "list",
  "new",
  "switch",
  "batch",
  "attach",
  "model",
  "stop",
  "sandbox",
  "status",
  "option",
  "state",
  "artifacts",
  "secret",
  "docs",
  "bots",
  "bot",
  "install",
  "login",
  "reset",
]);
const TELEGRAM_STALE_UPDATE_GRACE_SECONDS = 10;
const TELEGRAM_PROCESS_STARTED_AT_SECONDS = Math.floor(Date.now() / 1000);

const REPORT_CONTINUE_PROMPT = [
  "Continue the same task now.",
  "Do more concrete work before replying again.",
  "Do not restate the plan unless it changed because of a real finding.",
  "Reply again with exactly one first line: REPORT:progress or REPORT:result or REPORT:blocked.",
].join("\n");

class AutoContinueController {
  private readonly stops = new Set<string>();
  private readonly stopInProgress = new Set<string>();
  private readonly stopDedupUntil = new Map<string, number>();
  private readonly stopDedupMs = 10_000;
  private readonly suppressUntil = new Map<string, number>();
  private readonly suppressMs = 60_000;

  constructor(private readonly stopGatePath: string) {
    this.loadStopGates();
  }

  requestStop(botId: string, chatId: string, sessionId?: string): void {
    for (const key of this.keys(botId, chatId, sessionId)) {
      this.stops.add(key);
      this.suppressUntil.set(key, Date.now() + this.suppressMs);
    }
    this.persistStopGates();
  }

  requestSessionStop(sessionId: string): void {
    const key = this.sessionKey(sessionId);
    this.stops.add(key);
    this.suppressUntil.set(key, Date.now() + this.suppressMs);
    this.persistStopGates();
  }

  beginStop(botId: string, chatId: string, sessionId?: string): boolean {
    const key = this.primaryKey(botId, chatId, sessionId);
    const dedupUntil = this.stopDedupUntil.get(key);
    if (dedupUntil && Date.now() < dedupUntil) {
      return false;
    }
    if (dedupUntil) {
      this.stopDedupUntil.delete(key);
    }
    if (this.stopInProgress.has(key)) {
      return false;
    }

    this.stopInProgress.add(key);
    this.requestStop(botId, chatId, sessionId);
    return true;
  }

  finishStop(botId: string, chatId: string, sessionId?: string): void {
    const key = this.primaryKey(botId, chatId, sessionId);
    this.stopInProgress.delete(key);
    this.stopDedupUntil.set(key, Date.now() + this.stopDedupMs);
  }

  clear(botId: string, chatId: string, sessionId?: string): void {
    for (const key of this.keys(botId, chatId, sessionId)) {
      this.stops.delete(key);
    }
  }

  isStopRequested(botId: string, chatId: string, sessionId?: string): boolean {
    return this.keys(botId, chatId, sessionId).some((key) => this.stops.has(key));
  }

  isSuppressingNewWork(botId: string, chatId: string, sessionId?: string): boolean {
    for (const key of this.keys(botId, chatId, sessionId)) {
      if (this.isSuppressingKey(key)) {
        return true;
      }
    }
    return false;
  }

  private isSuppressingKey(key: string): boolean {
    const until = this.suppressUntil.get(key);
    if (!until) {
      return false;
    }
    if (Date.now() > until) {
      this.suppressUntil.delete(key);
      this.persistStopGates();
      return false;
    }
    return true;
  }

  private keys(botId: string, chatId: string, sessionId?: string): string[] {
    const keys = [this.chatKey(botId, chatId)];
    if (sessionId) {
      keys.push(this.sessionKey(sessionId));
    }
    return keys;
  }

  private primaryKey(botId: string, chatId: string, sessionId?: string): string {
    return sessionId ? this.sessionKey(sessionId) : this.chatKey(botId, chatId);
  }

  private chatKey(botId: string, chatId: string): string {
    return `${botId}:${chatId}`;
  }

  private sessionKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private loadStopGates(): void {
    try {
      const raw = fsSync.readFileSync(this.stopGatePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [key, until] of Object.entries(parsed)) {
        if (Number.isFinite(until) && until > now) {
          this.suppressUntil.set(key, until);
        }
      }
    } catch {
      // Missing or invalid gate files should not prevent the bot from starting.
    }
  }

  private persistStopGates(): void {
    const entries = Object.fromEntries(this.suppressUntil.entries());
    try {
      fsSync.mkdirSync(path.dirname(this.stopGatePath), { recursive: true });
      const tmpPath = `${this.stopGatePath}.tmp`;
      fsSync.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
      fsSync.renameSync(tmpPath, this.stopGatePath);
    } catch {
      // Stop should still work in memory even if persisting the gate fails.
    }
  }
}

export function createBot(token: string, bridge: BridgeService, botManagement: BotManagementService, botInfo: UserFromGetMe): Bot {
  const bot = new Bot(token, { botInfo });
  const autoContinue = new AutoContinueController(path.join(config.dataDir, "stop-gates.json"));
  const shellService = new RemoteShellService(config.commandTimeoutMs);
  const memoryService = new AgentMemoryService(config.dataDir);
  const sourceBotToken = token;
  const setupService = new ProviderSetupService(
    config.setupCommandTimeoutMs,
    (provider) => bridge.listAvailableProviders().includes(provider),
    {
      codex: config.codexInstallCommand,
      claude: config.claudeInstallCommand,
    },
    config.claudeLoginStartCommand,
    config.claudeLoginFinishCommand,
  );
  const messageBatcher = new TelegramMessageBatcher(
    config.telegramMessageBatchMs,
    async (target, botId, chatId, text) => {
      await bridge.logSystem(botId, chatId, `Telegram text dispatch (${text.length} chars).`);
      await runWithPendingAnimation(target.botToken, target.telegramChatId, async (helpers) => {
        return {
          chunks: await routeTelegramWorkLoop(
            bridge,
            botId,
            chatId,
            text,
            "Telegram text request",
            helpers,
            autoContinue,
            memoryService,
          ),
        };
      });
    },
  );
  const getBotId = (): string => bot.botInfo?.username ?? String(bot.botInfo?.id ?? token);
  const stopPreviousSessionForRebind = async (botId: string, chatId: string, reason: string): Promise<void> => {
    const previous = await bridge.status(botId, chatId).catch(() => undefined);
    if (!previous) {
      return;
    }
    autoContinue.requestSessionStop(previous.session.sessionId);
    messageBatcher.cancelPending(botId, chatId);
    messageBatcher.cancelManual(botId, chatId);
    await bridge.stopSessionRun(previous.session.sessionId, botId, chatId, reason);
  };
  const reply = async (ctx: Context, text: string, extra?: TelegramMessageOptions): Promise<TelegramMessageResult> => {
    if (!ctx.chat) {
      throw new Error("Telegram chat context is missing.");
    }
    try {
      return await sendTelegramMessage(token, ctx.chat.id, text, extra);
    } catch (error) {
      if (isTelegramForbiddenError(error)) {
        console.warn(`[telegram-delivery] bot=${getBotId()} chat=${ctx.chat.id} skipped: ${error instanceof Error ? error.message : String(error)}`);
        return { message_id: 0 };
      }
      throw error;
    }
  };

  bot.use(async (ctx, next) => {
    const updateKind = Object.keys(ctx.update).join(",");
    const text = ctx.message?.text ?? ctx.editedMessage?.text ?? ctx.channelPost?.text ?? "";
    const safeText = sanitizeLoggedTelegramText(text);
    const messageDate = ctx.message?.date ?? ctx.editedMessage?.date ?? ctx.channelPost?.date;
    if (messageDate && messageDate < TELEGRAM_PROCESS_STARTED_AT_SECONDS - TELEGRAM_STALE_UPDATE_GRACE_SECONDS) {
      console.log(
        `[tg-update-stale] bot=${getBotId()} kind=${updateKind} chat=${ctx.chat?.id ?? "?"} date=${messageDate} text=${JSON.stringify(safeText).slice(0, 240)}`,
      );
      return;
    }

    console.log(
      `[tg-update] bot=${getBotId()} kind=${updateKind} chat=${ctx.chat?.id ?? "?"} text=${JSON.stringify(safeText).slice(0, 240)}`,
    );
    if (ctx.chat) {
      await bridge.rememberTelegramContact({
        transport: "telegram",
        botId: getBotId(),
        botUsername: bot.botInfo?.username,
        chatId: String(ctx.chat.id),
        chatType: ctx.chat.type,
        ownerUserId: ctx.from ? String(ctx.from.id) : undefined,
        username: "username" in ctx.chat && typeof ctx.chat.username === "string" ? ctx.chat.username : undefined,
        firstName: "first_name" in ctx.chat && typeof ctx.chat.first_name === "string" ? ctx.chat.first_name : undefined,
        lastName: "last_name" in ctx.chat && typeof ctx.chat.last_name === "string" ? ctx.chat.last_name : undefined,
        title: "title" in ctx.chat && typeof ctx.chat.title === "string" ? ctx.chat.title : undefined,
        lastSeenAt: new Date().toISOString(),
      });
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args, rest } = parseCommand(ctx.message?.text, 1);
    const first = args[0]?.trim();

    if (rest?.trim()) {
      await reply(ctx, "Usage: `/start` or `/start codex` or `/start claude`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (first && !(["codex", "claude"] as const).includes(first.toLowerCase() as Provider)) {
      await reply(ctx, "Usage: `/start` or `/start codex` or `/start claude`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const explicitProvider = first ? first.toLowerCase() as Provider : undefined;
    const provider = await bridge.resolveStartProvider(explicitProvider);
    await stopPreviousSessionForRebind(botId, chatId, "Chat started a new session; previous session execution was stopped.");
    const mapping = await bridge.startSession(botId, chatId, provider);
    await reply(ctx, `Started a fresh ${provider} session.

${bridge.formatStatus(mapping)}`);
  });

  bot.command("help", async (ctx) => {
    await reply(ctx, HELP_TEXT);
  });

  const replySessionList = async (ctx: Context): Promise<void> => {
    if (!ctx.chat) {
      throw new Error("Telegram chat context is missing.");
    }

    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 1);
    const showAll = args[0] === "-a" || args[0] === "--all";
    const [mapping, sessions] = await Promise.all([
      bridge.status(botId, chatId),
      bridge.listSessions(),
    ]);
    const botSummary = await botManagement.formatCurrentBotSummary(botId);
    const sessionList = showAll
      ? await bridge.formatSessionListDetailed(
        sessions,
        mapping?.session.sessionId,
        await bridge.listActiveSessionIds(),
      )
      : bridge.formatSessionList(sessions, mapping?.session.sessionId);
    for (const chunk of flattenChunks([`${sessionList}\n\n${botSummary}`], 3900)) {
      await reply(ctx, chunk);
    }
  };

  bot.command("list", async (ctx) => {
    await replySessionList(ctx);
  });

  bot.command("new", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { rest } = parseCommand(ctx.message?.text, 0);
    await stopPreviousSessionForRebind(botId, chatId, "Chat created a new session; previous session execution was stopped.");
    const mapping = await bridge.createSession(botId, chatId, rest);
    await reply(ctx, `Created and bound a new ${mapping.session.mode} session.\n\n${bridge.formatCurrentSession(mapping)}`);
  });

  bot.command("switch", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 1);
    const sessionId = args[0];

    if (!sessionId) {
      await reply(ctx, "Usage: `/switch <session>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const previous = await bridge.status(botId, chatId).catch(() => undefined);
    const mapping = await bridge.switchSession(botId, chatId, sessionId);
    if (previous && previous.session.sessionId !== mapping.session.sessionId) {
      autoContinue.requestSessionStop(previous.session.sessionId);
      messageBatcher.cancelPending(botId, chatId);
      messageBatcher.cancelManual(botId, chatId);
      await bridge.stopSessionRun(previous.session.sessionId, botId, chatId, "Chat switched to another session; previous session execution was stopped.");
    }
    await reply(ctx, `Switched this chat to session ${sessionId}.\n\n${bridge.formatCurrentSession(mapping)}`);
  });

  bot.command("batch", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 1);
    const action = args[0]?.toLowerCase();

    if (!action || !["start", "send", "done", "cancel", "status"].includes(action)) {
      await reply(ctx, "Usage: `/batch start`, `/batch send`, `/batch cancel`, or `/batch status`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (action === "start") {
      messageBatcher.startManual(botId, chatId);
      await reply(ctx, "Batch collection started. Send the log fragments, then run `/batch send`.", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (action === "send" || action === "done") {
      const result = await messageBatcher.sendManual({ botToken: token, telegramChatId: ctx.chat.id }, botId, chatId);
      if (!result.found) {
        await reply(ctx, "No active batch. Run `/batch start` first.", { parse_mode: "Markdown" });
        return;
      }
      if (result.count === 0) {
        await reply(ctx, "Batch was empty.");
      }
      return;
    }

    if (action === "cancel") {
      const result = messageBatcher.cancelManual(botId, chatId);
      await reply(ctx, result.found ? `Canceled batch with ${result.count} collected message(s).` : "No active batch.");
      return;
    }

    const result = messageBatcher.manualStatus(botId, chatId);
    await reply(ctx, result.found ? `Batch collection is active with ${result.count} message(s).` : "No active batch.");
  });

  bot.command("attach", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 2);
    const provider = args[0]?.toLowerCase();
    const sessionId = args[1];

    if (!provider || !["codex", "claude"].includes(provider) || !sessionId) {
      await reply(ctx, "Usage: `/attach codex <thread_id>` or `/attach claude <session_id>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.attachPair(botId, chatId, provider as Provider, sessionId);
    await reply(ctx, `Attached this chat to existing ${provider} session ${sessionId}.

${bridge.formatStatus(mapping)}`);
  });

  bot.command("model", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args, rest } = parseCommand(ctx.message?.text, 1);
    const model = args[0]?.trim();

    if (rest?.trim()) {
      await reply(ctx, "Usage: `/model` or `/model <name|number>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (!model) {
      await reply(ctx, await bridge.formatModelSelection(botId, chatId), {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.setModel(botId, chatId, model);
    await reply(ctx, `Set ${mapping.session.mode} model to ${model}.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("stop", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(botId, chatId);
    const sessionId = mapping?.session.sessionId;
    autoContinue.requestStop(botId, chatId, sessionId);
    const pendingBatch = messageBatcher.cancelPending(botId, chatId);
    const manualBatch = messageBatcher.cancelManual(botId, chatId);
    if (!autoContinue.beginStop(botId, chatId, sessionId)) {
      const batchCount = pendingBatch.count + manualBatch.count;
      if (batchCount > 0) {
        await bridge.logSystem(botId, chatId, `Duplicate stop discarded ${batchCount} queued message(s).`);
      }
      return;
    }

    try {
      const result = await bridge.stopActiveRun(botId, chatId);
      await bridge.logSystem(botId, chatId, "Stop requested for auto-continue.");
      const batchCount = pendingBatch.count + manualBatch.count;
      await reply(
        ctx,
        result.stopped
          ? `Stop requested. Active work for ${result.sessionPublicId ?? "this session"} was interrupted, further automatic continuation will stop, and ${batchCount} queued message(s) were discarded.`
          : `Stop requested. No active provider process was running, but further automatic continuation will stop, and ${batchCount} queued message(s) were discarded.`,
      );
    } finally {
      autoContinue.finishStop(botId, chatId, sessionId);
    }
  });

  bot.command("status", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(botId, chatId);
    await reply(ctx, bridge.formatStatus(mapping));
  });

  bot.command("option", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 2);
    const option = args[0]?.toLowerCase();
    const value = args[1];

    if (!option) {
      await reply(ctx, formatRuntimeOptions());
      return;
    }

    if (option !== "retry" && option !== "timeout" && option !== "intent" && option !== "command-menu") {
      await reply(ctx, "Usage: `/option retry <count>`, `/option timeout <seconds>`, `/option intent <count>`, or `/option command-menu <on|off|refresh>`\n\n`retry` controls automatic continuation turns. `timeout` controls one provider execution limit. `intent` controls retries for untagged intent-only provider replies. `command-menu` controls Telegram slash-command autocomplete for all configured bots.", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (!value) {
      const current = option === "retry"
        ? `Current automatic continuation retry limit: ${formatRetryLimit(config.telegramAutoProgressMaxTurns)}\n\nUsage: \`/option retry <count>\``
        : option === "intent"
          ? `Current untagged intent retry limit: ${formatRetryLimit(config.telegramUntaggedIntentRetries)}\n\nUsage: \`/option intent <count>\``
          : option === "command-menu"
            ? `Current Telegram command menu: ${config.telegramCommandMenuEnabled ? "on" : "off"}\n\nUsage: \`/option command-menu on\`, \`/option command-menu off\`, or \`/option command-menu refresh\``
            : `Current provider execution timeout: ${formatTimeoutSeconds(config.commandTimeoutMs)}\n\nUsage: \`/option timeout <seconds>\``;
      await reply(ctx, current, {
        parse_mode: "Markdown",
      });
      return;
    }

    if (option === "command-menu") {
      const action = value.toLowerCase();
      if (!["on", "off", "refresh"].includes(action)) {
        await reply(ctx, "Invalid command-menu option. Use `/option command-menu on`, `/option command-menu off`, or `/option command-menu refresh`.", {
          parse_mode: "Markdown",
        });
        return;
      }

      const enabled = action === "refresh" ? config.telegramCommandMenuEnabled : action === "on";
      const result = await applyTelegramCommandMenuOption(enabled);
      if (action !== "refresh") {
        config.telegramCommandMenuEnabled = enabled;
        await upsertInstalledEnvValue("TELEGRAM_COMMAND_MENU_ENABLED", String(enabled));
      }
      await bridge.logSystem(botId, chatId, `Runtime option TELEGRAM_COMMAND_MENU_ENABLED ${action === "refresh" ? "refreshed" : `set to ${enabled}`}. ${result.summary}`);
      await reply(
        ctx,
        [
          action === "refresh"
            ? `Refreshed Telegram command menu for configured bots.`
            : `Set Telegram command menu to ${enabled ? "on" : "off"}.`,
          "",
          result.summary,
          action === "refresh" ? "" : `Saved: TELEGRAM_COMMAND_MENU_ENABLED=${enabled}`,
        ].filter(Boolean).join("\n"),
      );
      return;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
      await reply(ctx, option === "retry"
        ? "Invalid retry count. Use `0` or a positive integer, for example `/option retry 6`."
        : option === "intent"
          ? "Invalid intent retry count. Use `0` or a positive integer, for example `/option intent 4`."
          : "Invalid timeout. Use seconds as a positive integer, for example `/option timeout 600`.", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (option === "retry") {
      config.telegramAutoProgressMaxTurns = parsed;
      await upsertInstalledEnvValue("TELEGRAM_AUTO_PROGRESS_MAX_TURNS", String(parsed));
      await bridge.logSystem(botId, chatId, `Runtime option TELEGRAM_AUTO_PROGRESS_MAX_TURNS set to ${parsed}.`);
      await reply(ctx, `Set automatic continuation retry limit to ${formatRetryLimit(parsed)}.\n\nSaved: TELEGRAM_AUTO_PROGRESS_MAX_TURNS=${parsed}`);
      return;
    }

    if (option === "intent") {
      config.telegramUntaggedIntentRetries = parsed;
      await upsertInstalledEnvValue("TELEGRAM_UNTAGGED_INTENT_RETRIES", String(parsed));
      await bridge.logSystem(botId, chatId, `Runtime option TELEGRAM_UNTAGGED_INTENT_RETRIES set to ${parsed}.`);
      await reply(ctx, `Set untagged intent retry limit to ${formatRetryLimit(parsed)}.\n\nSaved: TELEGRAM_UNTAGGED_INTENT_RETRIES=${parsed}`);
      return;
    }

    if (parsed < 10) {
      await reply(ctx, "Invalid timeout. Use at least 10 seconds, for example `/option timeout 600`.", {
        parse_mode: "Markdown",
      });
      return;
    }

    config.commandTimeoutMs = parsed * 1000;
    await upsertInstalledEnvValue("COMMAND_TIMEOUT_MS", String(config.commandTimeoutMs));
    await bridge.logSystem(botId, chatId, `Runtime option COMMAND_TIMEOUT_MS set to ${config.commandTimeoutMs}.`);
    await reply(ctx, `Set provider execution timeout to ${formatTimeoutSeconds(config.commandTimeoutMs)}.\n\nSaved: COMMAND_TIMEOUT_MS=${config.commandTimeoutMs}`);
  });

  bot.command("state", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args, rest } = parseCommand(ctx.message?.text, 1);
    const action = args[0]?.toLowerCase() || "status";
    const mapping = await bridge.status(botId, chatId);
    if (!mapping) {
      await reply(ctx, "No paired session for this chat yet.");
      return;
    }

    if (action === "status") {
      await reply(ctx, await memoryService.formatSessionState(mapping.session));
      return;
    }
    if (action === "clear") {
      await memoryService.clearSessionState(mapping.session, "Cleared by /state clear.");
      await reply(ctx, `Cleared session state for ${mapping.session.publicId}.`);
      return;
    }
    if (action === "note") {
      const note = rest?.trim();
      if (!note) {
        await reply(ctx, "Usage: `/state note <내용>`", { parse_mode: "Markdown" });
        return;
      }
      await memoryService.addSessionNote(mapping.session, note);
      await reply(ctx, `Saved state note for ${mapping.session.publicId}.`);
      return;
    }
    await reply(ctx, "Usage: `/state`, `/state clear`, or `/state note <내용>`", { parse_mode: "Markdown" });
  });

  bot.command("artifacts", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 2);
    const action = args[0]?.toLowerCase() || "list";
    const mapping = await bridge.status(botId, chatId).catch(() => undefined);

    if (action === "list") {
      await reply(ctx, await memoryService.listArtifacts(mapping?.session));
      return;
    }
    if (action === "cleanup") {
      const days = Number.parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(days) || days < 1) {
        await reply(ctx, "Usage: `/artifacts cleanup <days>`", { parse_mode: "Markdown" });
        return;
      }
      await reply(ctx, await memoryService.cleanupArtifacts(days));
      return;
    }
    await reply(ctx, "Usage: `/artifacts list` or `/artifacts cleanup <days>`", { parse_mode: "Markdown" });
  });

  bot.command("secret", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const { args, rest } = parseCommand(ctx.message?.text, 2);
    const action = args[0]?.toLowerCase();
    const key = args[1]?.trim().toUpperCase();

    if (action === "list") {
      await reply(ctx, await memoryService.listSecrets());
      return;
    }
    if (action === "set") {
      if (!key || !rest?.trim()) {
        await reply(ctx, formatSecretHelp(), { parse_mode: "Markdown" });
        return;
      }
      await memoryService.setSecret(key, rest.trim());
      await reply(ctx, `Stored secret key ${key}. Value is hidden from agents and chat output.`);
      return;
    }
    if (action === "remove") {
      if (!key) {
        await reply(ctx, formatSecretHelp(), { parse_mode: "Markdown" });
        return;
      }
      const removed = await memoryService.removeSecret(key);
      await reply(ctx, removed ? `Removed secret key ${key}.` : `Secret key was not found: ${key}`);
      return;
    }
    await reply(ctx, formatSecretHelp(), { parse_mode: "Markdown" });
  });

  bot.command("docs", async (ctx) => {
    const { args, rest } = parseCommand(ctx.message?.text, 2);
    const action = args[0]?.toLowerCase() || "list";
    const keyword = args[1]?.trim();

    if (action === "list") {
      await reply(ctx, await memoryService.listDocuments());
      return;
    }
    if (action === "find") {
      if (!keyword) {
        await reply(ctx, "Usage: `/docs find <keyword>`", { parse_mode: "Markdown" });
        return;
      }
      await reply(ctx, await memoryService.findDocuments(keyword));
      return;
    }
    if (action === "pin") {
      await ensureOwnerControlAccess(ctx);
      if (!keyword || !rest?.trim()) {
        await reply(ctx, "Usage: `/docs pin <keyword> <path-or-folder> [note]`", { parse_mode: "Markdown" });
        return;
      }
      await memoryService.pinDocument(keyword, rest.trim());
      await reply(ctx, `Pinned docs keyword ${keyword} -> ${rest.trim()}`);
      return;
    }
    if (action === "remove") {
      await ensureOwnerControlAccess(ctx);
      if (!keyword) {
        await reply(ctx, "Usage: `/docs remove <keyword>`", { parse_mode: "Markdown" });
        return;
      }
      const removed = await memoryService.removeDocumentPin(keyword);
      await reply(ctx, removed ? `Removed docs keyword ${keyword}.` : `Docs keyword was not found: ${keyword}`);
      return;
    }
    await reply(ctx, "Usage: `/docs list`, `/docs find <keyword>`, `/docs pin <keyword> <path>`, or `/docs remove <keyword>`", { parse_mode: "Markdown" });
  });

  bot.command("bots", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const pendingNotice = await botManagement.getPendingOperationNotice();
    if (pendingNotice?.pending) {
      await reply(ctx, `${pendingNotice.message}\n\n${await botManagement.listBots()}`);
      return;
    }
    await reply(ctx, await botManagement.listBots());
  });

  bot.command("bot", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const sourceBotId = getBotId();
    const { args, rest } = parseCommand(ctx.message?.text, 2);
    const action = args[0]?.toLowerCase();

    if (!action || !["add", "doctor", "main", "remove", "reload"].includes(action)) {
      await reply(ctx, "Usage: `/bot add <token>`, `/bot doctor`, `/bot main <number|@username|id>`, `/bot remove <username|id>`, or `/bot reload`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (action === "add") {
      const rawSecond = args[1]?.trim();
      const token = rawSecond ?? rest?.trim() ?? "";

      if (!token) {
        await reply(ctx, "Usage: `/bot add <token>`", {
          parse_mode: "Markdown",
        });
        return;
      }

      const result = await botManagement.addBot(token, sourceBotId, sourceBotToken, ctx.chat.id);
      await reply(ctx, result.message);
      return;
    }

    if (action === "doctor") {
      const result = await botManagement.doctorBots(sourceBotId, sourceBotToken, ctx.chat.id);
      await reply(ctx, result.message);
      return;
    }

    if (action === "main") {
      const result = await botManagement.setMainBot(rest?.trim() ?? args[1]?.trim() ?? "");
      await reply(ctx, result.message);
      return;
    }

    if (action === "remove") {
      const result = await botManagement.removeBot(rest?.trim() ?? "", sourceBotId, sourceBotToken, ctx.chat.id);
      await reply(ctx, result.message);
      return;
    }

    const result = await botManagement.reloadBots(sourceBotId, sourceBotToken, ctx.chat.id);
    await reply(ctx, result.message);
  });

  bot.command("install", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const { args } = parseCommand(ctx.message?.text, 1);
    const provider = args[0]?.toLowerCase();

    if (!provider || !["codex", "claude"].includes(provider)) {
      await reply(ctx, "Usage: `/install codex` or `/install claude`", { parse_mode: "Markdown" });
      return;
    }

    await runWithPendingAnimation(token, ctx.chat.id, async () => {
      const result = await setupService.install(provider as Provider);
      if (result.after) {
        await bridge.rememberDefaultStartMode(provider as Provider);
      }
      return { chunks: flattenChunks([result.output], 3900) };
    });
  });

  bot.command("login", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const { args, rest } = parseCommand(ctx.message?.text, 1);
    const provider = args[0]?.toLowerCase();

    if (provider === "codex") {
      await runWithPendingAnimation(token, ctx.chat.id, async () => {
        const output = await setupService.startCodexLogin();
        await bridge.rememberDefaultStartMode("codex");
        return { chunks: flattenChunks([output], 3900) };
      });
      return;
    }

    if (provider !== "claude") {
      await reply(ctx, "Usage: `/login codex` or `/login claude` or `/login claude <token>`", { parse_mode: "Markdown" });
      return;
    }

    await runWithPendingAnimation(token, ctx.chat.id, async () => {
      const output = rest?.trim()
        ? await setupService.finishClaudeLogin(rest)
        : await setupService.startClaudeLogin();
      await bridge.rememberDefaultStartMode("claude");
      return { chunks: flattenChunks([output], 3900) };
    });
  });

  bot.command("sandbox", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 2);
    const provider = args[0]?.toLowerCase();
    const sandboxMode = args[1]?.toLowerCase();

    if (provider !== "codex" || !sandboxMode || !isCodexSandboxMode(sandboxMode)) {
      await reply(ctx, "Usage: `/sandbox codex <read-only|workspace-write|danger-full-access>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.setCodexSandboxMode(botId, chatId, sandboxMode);
    await reply(ctx, `Set Codex sandbox to ${sandboxMode}.\n\n${bridge.formatStatus(mapping)}`);
  });


  bot.command("reset", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    await stopPreviousSessionForRebind(botId, chatId, "Chat binding was reset; previous session execution was stopped.");
    await bridge.reset(botId, chatId);
    await reply(ctx, "Cleared all pairings for this chat.");
  });

  bot.on("message", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const photo = ctx.message.photo?.at(-1);
    const document = ctx.message.document;
    const voice = ctx.message.voice;
    const audio = ctx.message.audio;
    const text = ctx.message.text?.trim();

    if (text && isRecognizedSlashCommand(text, botId)) {
      return;
    }
    if (text && isUnsupportedSlashCommand(text, botId)) {
      await reply(ctx, `Unsupported command: ${text.split(/\s+/, 1)[0]}\nRun /help for available commands.`);
      return;
    }

    const mapping = await bridge.status(botId, chatId).catch(() => undefined);
    if (autoContinue.isSuppressingNewWork(botId, chatId, mapping?.session.sessionId)) {
      await bridge.logSystem(botId, chatId, "Telegram message ignored during stop cooldown.");
      await reply(ctx, "Stopped. Ignored this message so the previous work does not restart. Send a new message again in a moment to start fresh.");
      return;
    }

    if (photo) {
      const downloaded = await downloadTelegramFile(token, botId, chatId, photo.file_id, "telegram-photo.jpg");
      await memoryService.recordArtifact({
        session: mapping?.session,
        botId,
        chatId,
        kind: "image",
        filePath: downloaded.path,
        fileName: "telegram-photo.jpg",
        mimeType: "image/jpeg",
      });
      const message = await formatTelegramAttachmentPrompt("image", downloaded.path, ctx.message.caption?.trim());

      await bridge.logSystem(botId, chatId, `Telegram image received: ${downloaded.path}`);
      await runWithPendingAnimation(token, ctx.chat.id, async (helpers) => {
        return {
          chunks: await routeTelegramWorkLoop(
            bridge,
            botId,
            chatId,
            message,
            "Telegram image request",
            helpers,
            autoContinue,
            memoryService,
            sanitizeAttachmentResponseBlocks,
          ),
        };
      });
      return;
    }

    if (document) {
      const attachment = classifyTelegramDocument(document.mime_type, document.file_name);
      const downloaded = await downloadTelegramFile(token, botId, chatId, document.file_id, document.file_name);
      await memoryService.recordArtifact({
        session: mapping?.session,
        botId,
        chatId,
        kind: attachment.kind,
        filePath: downloaded.path,
        fileName: document.file_name,
        mimeType: document.mime_type,
      });
      const message = await formatTelegramAttachmentPrompt(
        attachment.kind,
        downloaded.path,
        ctx.message.caption?.trim(),
        {
          fileName: document.file_name,
          mimeType: document.mime_type,
          isFallback: attachment.isFallback,
        },
      );

      await bridge.logSystem(botId, chatId, `Telegram ${attachment.kind} received: ${downloaded.path}`);
      await runWithPendingAnimation(token, ctx.chat.id, async (helpers) => {
        return {
          chunks: await routeTelegramWorkLoop(
            bridge,
            botId,
            chatId,
            message,
            `Telegram ${attachment.kind} request`,
            helpers,
            autoContinue,
            memoryService,
            sanitizeAttachmentResponseBlocks,
          ),
        };
      });
      return;
    }

    if (voice || audio) {
      const attachmentKind = voice ? "voice message" : "audio file";
      const downloaded = await downloadTelegramFile(
        token,
        botId,
        chatId,
        voice ? voice.file_id : audio!.file_id,
        voice ? "telegram-voice.ogg" : audio?.file_name,
      );
      await memoryService.recordArtifact({
        session: mapping?.session,
        botId,
        chatId,
        kind: attachmentKind,
        filePath: downloaded.path,
        fileName: voice ? "telegram-voice.ogg" : audio?.file_name,
        mimeType: voice?.mime_type ?? audio?.mime_type,
      });
      const message = await formatTelegramAttachmentPrompt(attachmentKind, downloaded.path, ctx.message.caption?.trim());

      await bridge.logSystem(botId, chatId, `Telegram ${attachmentKind} received: ${downloaded.path}`);
      await runWithPendingAnimation(token, ctx.chat.id, async (helpers) => {
        return {
          chunks: await routeTelegramWorkLoop(
            bridge,
            botId,
            chatId,
            message,
            `Telegram ${attachmentKind} request`,
            helpers,
            autoContinue,
            memoryService,
            sanitizeAttachmentResponseBlocks,
          ),
        };
      });
      return;
    }

    if (!text) {
      return;
    }

    if (mapping) {
      const localStatus = await memoryService.formatLocalStatusQuestion(mapping.session, text);
      if (localStatus) {
        await bridge.logSystem(botId, chatId, "Answered local session status without provider execution.");
        await reply(ctx, localStatus);
        return;
      }
    }

    if (isRemoteShellMessage(text)) {
      const shellRequest = parseRemoteShellRequest(text);
      if (!shellRequest) {
        await reply(ctx, "Usage: `/! <command>`, `/!cmd <command>`, or `/!bash <command>`", {
          parse_mode: "Markdown",
        });
        return;
      }

      const chatSession = await ensureRemoteShellAccess(ctx, bridge, botId, chatId);
      await bridge.logSystem(botId, chatId, `Remote shell request (${shellRequest.kind}): ${shellRequest.command}`);

      await runWithPendingAnimation(token, ctx.chat.id, async () => {
        const result = await shellService.execute(shellRequest.command, chatSession.session.workspace, shellRequest.kind);
        await bridge.logSystem(botId, chatId, `Remote shell finished (${result.shell}, exit ${result.code ?? "unknown"}).`);
        return {
          chunks: flattenChunks([formatRemoteShellResult(result, shellRequest.command, chatSession.session.workspace)], 3900),
          parseMode: "HTML",
        };
      });
      return;
    }

    await bridge.logSystem(botId, chatId, `Telegram text received (${text.length} chars).`);
    await messageBatcher.enqueue({ botToken: token, telegramChatId: ctx.chat.id }, botId, chatId, text);
  });

  bot.catch((error) => {
    const ctx = error.ctx;
    console.error(`Telegram update ${ctx.update.update_id} failed`);

    if (isTelegramForbiddenError(error.error)) {
      console.warn(`[telegram-delivery] bot=${getBotId()} chat=${ctx.chat?.id ?? "?"} skipped: ${error.error instanceof Error ? error.error.message : String(error.error)}`);
      return;
    }

    if (error.error instanceof GrammyError) {
      console.error("Telegram API error:", error.error.description);
      return;
    }

    if (error.error instanceof HttpError) {
      console.error("Network error:", error.error);
      return;
    }

    console.error("Unhandled error:", error.error);
    if (ctx.chat) {
      void sendTelegramMessage(token, ctx.chat.id, error.error instanceof Error ? error.error.message : "An unexpected error occurred.").catch(() => undefined);
    }
  });

  return bot;
}

type PendingTelegramBatch = {
  target: TelegramReplyTarget;
  botId: string;
  chatId: string;
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
};

type ManualTelegramBatch = {
  messages: string[];
};

type TelegramReplyTarget = {
  botToken: string;
  telegramChatId: number;
};

class TelegramMessageBatcher {
  private readonly pending = new Map<string, PendingTelegramBatch>();
  private readonly manual = new Map<string, ManualTelegramBatch>();

  constructor(
    private readonly delayMs: number,
    private readonly onBatch: (target: TelegramReplyTarget, botId: string, chatId: string, text: string) => Promise<void>,
  ) {}

  async enqueue(target: TelegramReplyTarget, botId: string, chatId: string, text: string): Promise<void> {
    const key = this.key(botId, chatId);
    const manualBatch = this.manual.get(key);
    if (manualBatch) {
      manualBatch.messages.push(text);
      return;
    }

    if (this.delayMs === 0) {
      await this.run(target, botId, chatId, text);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.target = target;
      existing.messages.push(text);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        void this.flush(key);
      }, this.delayMs);
      return;
    }

    this.pending.set(key, {
      target,
      botId,
      chatId,
      messages: [text],
      timer: setTimeout(() => {
        void this.flush(key);
      }, this.delayMs),
    });
  }

  startManual(botId: string, chatId: string): void {
    const key = this.key(botId, chatId);
    const pendingBatch = this.pending.get(key);
    if (pendingBatch) {
      clearTimeout(pendingBatch.timer);
      this.pending.delete(key);
    }

    this.manual.set(key, { messages: pendingBatch?.messages ?? [] });
  }

  async sendManual(target: TelegramReplyTarget, botId: string, chatId: string): Promise<{ found: boolean; count: number }> {
    const key = this.key(botId, chatId);
    const batch = this.manual.get(key);
    if (!batch) {
      return { found: false, count: 0 };
    }

    this.manual.delete(key);
    if (batch.messages.length === 0) {
      return { found: true, count: 0 };
    }

    await this.run(target, botId, chatId, batch.messages.join("\n"));
    return { found: true, count: batch.messages.length };
  }

  cancelManual(botId: string, chatId: string): { found: boolean; count: number } {
    const key = this.key(botId, chatId);
    const batch = this.manual.get(key);
    if (!batch) {
      return { found: false, count: 0 };
    }

    this.manual.delete(key);
    return { found: true, count: batch.messages.length };
  }

  cancelPending(botId: string, chatId: string): { found: boolean; count: number } {
    const key = this.key(botId, chatId);
    const batch = this.pending.get(key);
    if (!batch) {
      return { found: false, count: 0 };
    }

    clearTimeout(batch.timer);
    this.pending.delete(key);
    return { found: true, count: batch.messages.length };
  }

  manualStatus(botId: string, chatId: string): { found: boolean; count: number } {
    const batch = this.manual.get(this.key(botId, chatId));
    return batch ? { found: true, count: batch.messages.length } : { found: false, count: 0 };
  }

  private async flush(key: string): Promise<void> {
    const batch = this.pending.get(key);
    if (!batch) {
      return;
    }

    this.pending.delete(key);
    clearTimeout(batch.timer);

    await this.run(batch.target, batch.botId, batch.chatId, batch.messages.join("\n"));
  }

  private async run(target: TelegramReplyTarget, botId: string, chatId: string, text: string): Promise<void> {
    try {
      await this.onBatch(target, botId, chatId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      console.error(`[telegram-batch] bot=${botId} chat=${chatId} failed: ${message}`, error);
      await sendTelegramMessage(target.botToken, target.telegramChatId, message).catch(() => undefined);
    }
  }

  private key(botId: string, chatId: string): string {
    return `${botId}:${chatId}`;
  }
}

function sanitizeLoggedTelegramText(text: string): string {
  const trimmed = text.trim();
  if (/^\/bot\s+add\s+/i.test(trimmed)) {
    return "/bot add [redacted]";
  }
  if (/^\/login\s+claude\s+/i.test(trimmed)) {
    return "/login claude [redacted]";
  }
  if (/^\/secret\s+set\s+/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    return `/secret set ${parts[2] ?? "[key]"} [redacted]`;
  }
  return text;
}

async function runWithPendingAnimation(
  botToken: string,
  chatId: number,
  task: (helpers: PendingAnimationHelpers) => Promise<{ chunks: string[]; parseMode?: "HTML" | "MarkdownV2" }>,
): Promise<void> {
  let typingStopped = false;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  let typingInFlight = false;
  const pulseTyping = (): void => {
    if (typingStopped) {
      return;
    }

    if (!typingInFlight) {
      typingInFlight = true;
      void sendTelegramChatAction(botToken, chatId, "typing")
        .catch((error) => {
          if (isTelegramForbiddenError(error)) {
            console.warn(`[telegram-delivery] chat=${chatId} skipped typing action: ${error instanceof Error ? error.message : String(error)}`);
            typingStopped = true;
            return;
          }
          console.warn(`[telegram-chat-action] chat=${chatId} failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          typingInFlight = false;
        });
    }

    typingTimer = setTimeout(() => {
      pulseTyping();
    }, config.telegramTypingIntervalMs);
    typingTimer.unref?.();
  };

  pulseTyping();

  try {
    const helpers: PendingAnimationHelpers = {
      reportProgress: async (chunks, parseMode) => {
        const normalized = await normalizeTelegramDelivery(chunks);
        const progressChunks = flattenChunks(normalized.chunks, 3900);
        if (progressChunks.length === 0 && normalized.documents.length === 0) {
          return;
        }

        const rendered = formatProviderTelegramChunks(progressChunks, parseMode);
        const extra = rendered.parseMode ? { parse_mode: rendered.parseMode } : undefined;
        for (const chunk of rendered.chunks) {
          await sendTelegramMessage(botToken, chatId, chunk, extra);
        }
        if (normalized.documents.length > 0) {
          await sendTelegramDocuments(botToken, chatId, normalized.documents);
        }
      },
    };

    const result = await task(helpers);
    const normalized = await normalizeTelegramDelivery(result.chunks);
    const chunks = flattenChunks(normalized.chunks, 3900);

    if (chunks.length === 0 && normalized.documents.length === 0) {
      await sendTelegramMessage(botToken, chatId, "Response was empty.");
      return;
    }

    const rendered = formatProviderTelegramChunks(chunks, result.parseMode);
    const extra = rendered.parseMode ? { parse_mode: rendered.parseMode } : undefined;
    for (const chunk of rendered.chunks) {
      await sendTelegramMessage(botToken, chatId, chunk, extra);
    }
    if (normalized.documents.length > 0) {
      await sendTelegramDocuments(botToken, chatId, normalized.documents);
    }
  } catch (error) {
    if (error instanceof SilentTelegramAbort) {
      return;
    }
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    console.error(`[telegram-pending] chat=${chatId} failed: ${message}`, error);
    await sendTelegramMessage(botToken, chatId, message).catch(() => undefined);
  } finally {
    typingStopped = true;
    if (typingTimer) {
      clearTimeout(typingTimer);
    }
  }
}

async function routeTelegramWorkLoop(
  bridge: BridgeService,
  botId: string,
  chatId: string,
  message: string,
  label: string,
  helpers: PendingAnimationHelpers,
  autoContinue: AutoContinueController,
  memoryService: AgentMemoryService,
  transform: (blocks: string[]) => string[] = (blocks) => blocks,
): Promise<string[]> {
  const currentSession = await bridge.status(botId, chatId);
  const sessionId = currentSession?.session.sessionId;
  if (currentSession) {
    await memoryService.recordInstruction(currentSession.session, message);
  }
  const managedContext = currentSession
    ? await memoryService.formatProviderContext(currentSession.session)
    : "";
  autoContinue.clear(botId, chatId, sessionId);
  let prompt = appendManagedContext(appendReportProtocol(message), managedContext);
  const maxTurns = config.telegramAutoProgressMaxTurns;
  const emptyResponseRetries = config.telegramEmptyResponseRetries;
  const retryableErrorRetries = config.telegramRetryableErrorRetries;
  const retryableErrorDelayMs = config.telegramRetryableErrorDelayMs;
  const untaggedIntentRetries = config.telegramUntaggedIntentRetries;
  let emptyResponseRetryCount = 0;
  let retryableErrorCount = 0;
  let untaggedIntentRetryCount = 0;
  let missingEvidenceRetryCount = 0;
  let deliveredProgressCount = 0;
  const ensureStillBound = async (phase: string): Promise<void> => {
    if (!sessionId) {
      return;
    }
    if (await bridge.isChatBoundToSession(botId, chatId, sessionId)) {
      return;
    }
    autoContinue.requestSessionStop(sessionId);
    await bridge.stopSessionRun(
      sessionId,
      botId,
      chatId,
      `Telegram work loop stopped during ${phase} because the chat is now bound to another session.`,
    );
    throw new SilentTelegramAbort(`Session ${currentSession?.session.publicId ?? sessionId} is no longer bound to this chat.`);
  };

  for (let turn = 1; ; turn += 1) {
    if (typeof maxTurns === "number" && maxTurns > 0 && turn > maxTurns) {
      const limitMessage = `Automatic continue limit (${maxTurns}) reached before a final result.`;
      await bridge.logSystem(botId, chatId, limitMessage);
      autoContinue.clear(botId, chatId, sessionId);
      return [limitMessage];
    }

    if (autoContinue.isStopRequested(botId, chatId, sessionId)) {
      const stopMessage = "Automatic continuation stopped.";
      await bridge.logSystem(botId, chatId, stopMessage);
      autoContinue.clear(botId, chatId, sessionId);
      return [stopMessage];
    }

    await ensureStillBound(`turn ${turn} start`);
    const turnLabel = `${label} turn ${turn}`;
    await bridge.logSystem(botId, chatId, `${turnLabel} started.`);

    try {
      const responses = sessionId
        ? await bridge.routeSessionMessageForChat(sessionId, botId, chatId, prompt)
        : await bridge.routeMessage(botId, chatId, prompt);
      await ensureStillBound(`${turnLabel} response`);
      const parsed = parseReportResponses(bridge.formatResponses(responses), transform);
      await bridge.logSystem(botId, chatId, `${turnLabel} returned ${parsed.kind}.`);
      emptyResponseRetryCount = 0;
      retryableErrorCount = 0;

      if (parsed.kind === "progress") {
        untaggedIntentRetryCount = 0;
        missingEvidenceRetryCount = 0;
        deliveredProgressCount += 1;
        if (currentSession) {
          const progress = await memoryService.recordProgress(currentSession.session, parsed.chunks.join("\n"));
          if (progress.repeated) {
            const repeatedMessage = [
              "Repeated progress detected. The same work pattern has appeared 3 or more times.",
              "Automatic continuation stopped so the task can be inspected instead of looping.",
            ].join("\n");
            await bridge.logSystem(botId, chatId, repeatedMessage);
            autoContinue.clear(botId, chatId, sessionId);
            return [repeatedMessage];
          }
        }
        await ensureStillBound(`${turnLabel} progress delivery`);
        await helpers.reportProgress(parsed.chunks);
        if (autoContinue.isStopRequested(botId, chatId, sessionId)) {
          const stopMessage = "Automatic continuation stopped after the latest progress report.";
          await bridge.logSystem(botId, chatId, stopMessage);
          autoContinue.clear(botId, chatId, sessionId);
          return [stopMessage];
        }
        prompt = appendManagedContext(REPORT_CONTINUE_PROMPT, managedContext);
        continue;
      }

      if (parsed.kind === "result") {
        untaggedIntentRetryCount = 0;
        const resultText = parsed.chunks.join("\n");
        const evidenceIssue = classifyMissingResultEvidence(resultText);
        if (evidenceIssue && missingEvidenceRetryCount < 1) {
          missingEvidenceRetryCount += 1;
          const retryMessage = `${turnLabel} returned a result without required evidence: ${evidenceIssue}`;
          await bridge.logSystem(botId, chatId, retryMessage);
          prompt = appendManagedContext(formatMissingEvidenceRetryPrompt(resultText, evidenceIssue), managedContext);
          continue;
        }
        if (evidenceIssue) {
          const blockedMessage = [
            "Provider reported a completed result without concrete evidence after a retry.",
            `Reason: ${evidenceIssue}`,
            "Automatic continuation stopped so the work is not accepted on an unsupported claim.",
          ].join("\n");
          await bridge.logSystem(botId, chatId, blockedMessage);
          autoContinue.clear(botId, chatId, sessionId);
          return [blockedMessage];
        }
        await ensureStillBound(`${turnLabel} final delivery`);
        if (currentSession) {
          await memoryService.completeTask(currentSession.session, parsed.chunks.join("\n"));
        }
        autoContinue.clear(botId, chatId, sessionId);
        return parsed.chunks;
      }

      if (parsed.kind === "blocked") {
        untaggedIntentRetryCount = 0;
        missingEvidenceRetryCount = 0;
        await ensureStillBound(`${turnLabel} final delivery`);
        autoContinue.clear(botId, chatId, sessionId);
        return parsed.chunks;
      }

      if (looksLikeUntaggedIntentOnlyResponse(parsed.chunks.join("\n")) && untaggedIntentRetryCount < untaggedIntentRetries) {
        untaggedIntentRetryCount += 1;
        const retryMessage = `${turnLabel} returned an untagged intent-only response; asking provider to do concrete work before replying.`;
        await bridge.logSystem(botId, chatId, retryMessage);
        prompt = appendManagedContext(formatUntaggedIntentRetryPrompt(parsed.chunks.join("\n")), managedContext);
        continue;
      }

      await bridge.logSystem(botId, chatId, `${turnLabel} returned an untagged response; treating it as final output.`);
      autoContinue.clear(botId, chatId, sessionId);
      return parsed.chunks;
    } catch (error) {
      if (error instanceof SilentTelegramAbort) {
        throw error;
      }
      const messageText = error instanceof Error ? error.message : "An unexpected error occurred.";
      const retryable = classifyRetryableProviderIssue(messageText, retryableErrorDelayMs);

      if (isProviderTimeoutError(messageText)) {
        const timeoutMessage = formatProviderTimeoutFinalMessage(messageText);
        console.warn(`[telegram-route] bot=${botId} chat=${chatId} ${turnLabel} timed out: ${messageText}`);
        await bridge.logSystem(botId, chatId, `${turnLabel} timed out: ${messageText}`);
        autoContinue.clear(botId, chatId, sessionId);
        return [timeoutMessage];
      }

      if (isEmptyResponseError(messageText) && emptyResponseRetryCount < emptyResponseRetries) {
        emptyResponseRetryCount += 1;
        const retryMessage = `${turnLabel} returned an empty response; retrying automatic continuation (${emptyResponseRetryCount}/${emptyResponseRetries}).`;
        console.warn(`[telegram-route] bot=${botId} chat=${chatId} ${retryMessage}`);
        await bridge.logSystem(botId, chatId, retryMessage);
        prompt = appendManagedContext(REPORT_CONTINUE_PROMPT, managedContext);
        continue;
      }

      if (retryable && retryableErrorCount < retryableErrorRetries) {
        retryableErrorCount += 1;
        const retryMessage = formatRetryableProviderRetryMessage(retryable, retryableErrorCount, retryableErrorRetries);
        console.warn(`[telegram-route] bot=${botId} chat=${chatId} ${turnLabel} retrying: ${messageText}`);
        await bridge.logSystem(botId, chatId, `${turnLabel} retrying after temporary provider issue: ${messageText}`);
        await helpers.reportProgress([retryMessage]);
        if (autoContinue.isStopRequested(botId, chatId, sessionId)) {
          const stopMessage = "Automatic continuation stopped after the latest retry notice.";
          await bridge.logSystem(botId, chatId, stopMessage);
          autoContinue.clear(botId, chatId, sessionId);
          return [stopMessage];
        }
        await sleep(retryable.retryAfterMs);
        prompt = appendManagedContext(REPORT_CONTINUE_PROMPT, managedContext);
        continue;
      }

      console.error(`[telegram-route] bot=${botId} chat=${chatId} ${turnLabel} failed: ${messageText}`, error);
      await bridge.logSystem(botId, chatId, `${turnLabel} failed: ${messageText}`);
      autoContinue.clear(botId, chatId, sessionId);

      if (retryable) {
        return [formatRetryableProviderFinalMessage(retryable)];
      }

      if (isEmptyResponseError(messageText) && deliveredProgressCount > 0) {
        return [
          "The last progress report was delivered, but the follow-up provider response came back empty. Automatic continuation stopped here.",
          "Send a new message such as `continue` to resume the same session from the latest state.",
        ];
      }

      throw error;
    }
  }
}

type PendingAnimationHelpers = {
  reportProgress: (chunks: string[], parseMode?: "HTML" | "MarkdownV2") => Promise<void>;
};

class SilentTelegramAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SilentTelegramAbort";
  }
}

type ReportKind = "progress" | "result" | "blocked" | "unknown";
type RetryableProviderIssueKind = "capacity" | "empty-response";

type RetryableProviderIssue = {
  kind: RetryableProviderIssueKind;
  retryAfterMs: number;
};

function appendReportProtocol(message: string): string {
  return `${message}\n\n${REPORT_PROTOCOL_PROMPT}`;
}

function appendManagedContext(message: string, managedContext: string): string {
  if (!managedContext.trim()) {
    return message;
  }
  return `${managedContext}\n\nUser request:\n${message}`;
}

function parseReportResponses(
  formattedBlocks: string[],
  transform: (blocks: string[]) => string[],
): { kind: ReportKind; chunks: string[] } {
  if (formattedBlocks.length === 0) {
    return { kind: "unknown", chunks: [] };
  }

  const parsedBlocks = formattedBlocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const reportLineIndex = lines.findIndex((line, index) =>
      index <= 1 && /^REPORT:(progress|result|blocked)$/i.test(line.trim()),
    );
    if (reportLineIndex < 0) {
      return {
        kind: "unknown" as ReportKind,
        text: block.trim(),
      };
    }

    const header = lines.slice(0, reportLineIndex).join("\n").trim();
    const reportLine = lines[reportLineIndex]!.trim();
    const match = /^REPORT:(progress|result|blocked)$/i.exec(reportLine);
    let kind = (match?.[1]?.toLowerCase() as ReportKind | undefined) ?? "unknown";
    const body = lines.slice(reportLineIndex + 1).join("\n").trim();
    if ((kind === "progress" || kind === "result") && looksLikeBlockedBody(body)) {
      kind = "blocked";
    }
    return {
      kind,
      text: body ? [header, body].filter(Boolean).join("\n") : "",
    };
  });

  const kind = parsedBlocks[0]?.kind ?? "unknown";
  const chunks = transform(parsedBlocks.map((item) => item.text));
  return { kind, chunks };
}

function formatProviderTelegramChunks(
  chunks: string[],
  explicitParseMode?: "HTML" | "MarkdownV2",
): { chunks: string[]; parseMode?: "HTML" | "MarkdownV2" } {
  if (explicitParseMode) {
    return { chunks, parseMode: explicitParseMode };
  }

  return {
    chunks: chunks.map((chunk) => renderTelegramHtml(chunk)),
    parseMode: "HTML",
  };
}

function renderTelegramHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  const rendered: string[] = [];
  let codeFence: string[] | undefined;

  for (const line of lines) {
    if (/^```\w*\s*$/.test(line.trim())) {
      if (codeFence) {
        rendered.push(`<pre>${escapeTelegramHtml(codeFence.join("\n"))}</pre>`);
        codeFence = undefined;
      } else {
        codeFence = [];
      }
      continue;
    }

    if (codeFence) {
      codeFence.push(line);
      continue;
    }

    rendered.push(renderTelegramInlineHtml(line));
  }

  if (codeFence) {
    rendered.push(`<pre>${escapeTelegramHtml(codeFence.join("\n"))}</pre>`);
  }

  return rendered.join("\n");
}

function renderTelegramInlineHtml(line: string): string {
  const parts = line.split(/(`[^`\n]+`)/g);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`;
    }
    return escapeTelegramHtml(part);
  }).join("");
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function looksLikeUntaggedIntentOnlyResponse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const hasConcreteEvidence = [
    /REPORT:/i,
    /(완료|통과|실패|확인 결과|검증 결과|원인|근거|수정했습니다|배포했습니다|커밋|푸시)/,
    /\b(git status|git diff|npm run|node --check|docker|journalctl|grep|rg)\b/i,
    /`[^`]+`/,
    /:\d{1,5}\b/,
  ].some((pattern) => pattern.test(normalized));
  if (hasConcreteEvidence) {
    return false;
  }

  return [
    /(하겠습니다|진행하겠습니다|확인하겠습니다|수정하겠습니다|검증하겠습니다|대조하겠습니다|보겠습니다)/,
    /(진행해서|확인해서|수정해서|검증해서).*(하겠습니다|진행하겠습니다)/,
    /\b(I will|I'll|I am going to|going to|will continue|will check|will verify)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function formatUntaggedIntentRetryPrompt(lastResponse: string): string {
  return [
    "The previous response did not follow the REPORT protocol and only stated intent without concrete evidence.",
    "Do not repeat the plan or say what you will do.",
    "Do concrete work now before replying again.",
    "Reply with exactly one first line: REPORT:progress, REPORT:result, or REPORT:blocked.",
    "If you cannot continue, use REPORT:blocked and state the exact blocker.",
    "",
    "Previous invalid response:",
    lastResponse.trim(),
  ].join("\n");
}

function classifyMissingResultEvidence(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  if (!looksLikeCompletedWorkClaim(normalized)) {
    return undefined;
  }

  if (hasConcreteResultEvidence(normalized)) {
    return undefined;
  }

  return "REPORT:result claims completed work but does not include concrete evidence.";
}

function looksLikeCompletedWorkClaim(text: string): boolean {
  return [
    /(수정|반영|배포|커밋|푸시|전송|생성|삭제|추가|적용|구현|저장|업데이트|등록|제거|정리|마이그레이션|검증|테스트|빌드).{0,24}(완료|했습니다|됐습니다|성공|통과)/,
    /(완료했습니다|완료됐습니다|끝났습니다|처리했습니다)/,
    /\b(fixed|implemented|deployed|committed|pushed|sent|created|deleted|updated|added|removed|migrated|verified|passed|completed|built)\b/i,
  ].some((pattern) => pattern.test(text));
}

function hasConcreteResultEvidence(text: string): boolean {
  return [
    /```/,
    /`[^`]+`/,
    /\b[0-9a-f]{7,40}\b/i,
    /sha256:[0-9a-f]{20,}/i,
    /\b(HTTP\s+\d{3}|exit\s+\d+|active|passed|failed)\b/i,
    /\b(npm run|git status|git diff|node --check|docker|journalctl|curl|psql|grep|rg|bash)\b/i,
    /\/[A-Za-z0-9._/-]{3,}/,
    /\b[A-Za-z0-9._/-]+\.(?:js|ts|tsx|jsx|sql|md|json|yml|yaml|sh|py|css|html|txt|log)\b/,
    /:\d{1,5}\b/,
    /(근거|검증|변경 파일|커밋|푸시|배포|로그|명령|출력|파일|라인|경로|상태)\s*:/,
  ].some((pattern) => pattern.test(text));
}

function formatMissingEvidenceRetryPrompt(lastResponse: string, issue: string): string {
  return [
    "The previous REPORT:result was not accepted by RemoteAgent.",
    issue,
    "RemoteAgent does not inspect code or decide whether the work is correct.",
    "You, the provider, must either provide concrete evidence for the completed work or change the reply to REPORT:progress or REPORT:blocked.",
    "Do not repeat a bare completion claim.",
    "Reply with exactly one first line: REPORT:progress, REPORT:result, or REPORT:blocked.",
    "",
    "Accepted evidence examples: file paths, line references, commands and outputs, log paths, commit IDs, image digests, deployment status, or explicit verification output.",
    "",
    "Previous unsupported result:",
    lastResponse.trim(),
  ].join("\n");
}

function isEmptyResponseError(message: string): boolean {
  return /empty response/i.test(message);
}

function looksLikeBlockedBody(text: string): boolean {
  if (!text.trim()) {
    return false;
  }

  const blockedPatterns = [
    /\b(sudo|usermod|setfacl|chmod|chown|relogin|re-login|new login session)\b/i,
    /\b(waiting on|need you to|you need to|please run|please do|manual step|admin step|external fix)\b/i,
    /\b(permission denied|permission change|ssh access|api key|login required|authentication required)\b/i,
    /적용되면.*(다시|이어서|계속)/i,
    /해주시면.*(다시|이어서|계속)/i,
    /권한.*(필요|없)/i,
    /로그인 세션.*필요/i,
    /관리자.*조치/i,
  ];

  return blockedPatterns.some((pattern) => pattern.test(text));
}

function classifyRetryableProviderIssue(message: string, retryAfterMs: number): RetryableProviderIssue | undefined {
  if (/selected model is at capacity/i.test(message)) {
    return { kind: "capacity", retryAfterMs };
  }

  if (isEmptyResponseError(message)) {
    return { kind: "empty-response", retryAfterMs };
  }

  return undefined;
}

function formatRetryableProviderRetryMessage(issue: RetryableProviderIssue, attempt: number, maxAttempts: number): string {
  const waitSeconds = Math.max(1, Math.round(issue.retryAfterMs / 1000));

  switch (issue.kind) {
    case "capacity":
      return `선택한 모델이 capacity 상태라 ${waitSeconds}초 후 다시 시도합니다. (${attempt}/${maxAttempts})`;
    case "empty-response":
      return `후속 응답이 비어 있어 ${waitSeconds}초 후 다시 시도합니다. (${attempt}/${maxAttempts})`;
  }
}

function formatRetryableProviderFinalMessage(issue: RetryableProviderIssue): string {
  switch (issue.kind) {
    case "capacity":
      return "선택한 모델이 capacity 상태라 자동 재시도를 모두 사용했습니다. 잠시 후 다시 시도하거나 `/model`로 다른 모델을 선택해 주세요.";
    case "empty-response":
      return "후속 응답이 반복해서 비어 자동 재시도를 중단했습니다. 같은 세션에서 다시 시도해 주세요.";
  }
}

function isProviderTimeoutError(message: string): boolean {
  return /\b(Codex|Claude)\s+timed out after\s+\d+s without returning a final reply/i.test(message);
}

function formatProviderTimeoutFinalMessage(message: string): string {
  const match = /\b(Codex|Claude)\s+timed out after\s+(\d+)s/i.exec(message);
  const provider = match?.[1] ?? "Provider";
  const seconds = match?.[2] ?? String(Math.round(config.commandTimeoutMs / 1000));
  return [
    `${provider} 실행이 ${seconds}초 안에 최종 응답을 반환하지 않아 중단했습니다.`,
    "",
    "같은 요청을 즉시 재시도하지 않았습니다. 이미 실행 프로세스가 timeout으로 종료된 상태라 반복 재시도하면 같은 루프가 생깁니다.",
    "",
    "긴 작업이면 먼저 timeout을 늘린 뒤 다시 요청하세요.",
    "예: /option timeout 600",
  ].join("\n");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureOwnerControlAccess(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== "private") {
    throw new Error("This command is available only in private 1:1 chats.");
  }

  if (!config.telegramOwnerId) {
    throw new Error("This command is disabled until TELEGRAM_OWNER_ID is configured.");
  }

  if (String(ctx.from?.id ?? "") !== config.telegramOwnerId) {
    throw new Error("This command is available only to the configured bot owner.");
  }
}

async function ensureRemoteShellAccess(ctx: Context, bridge: BridgeService, botId: string, chatId: string): Promise<ChatSession> {
  if (ctx.chat?.type !== "private") {
    throw new Error("Remote shell is available only in private 1:1 chats.");
  }

  if (!config.telegramOwnerId) {
    throw new Error("Remote shell is disabled until TELEGRAM_OWNER_ID is configured.");
  }

  if (String(ctx.from?.id ?? "") !== config.telegramOwnerId) {
    throw new Error("Remote shell is available only to the configured bot owner.");
  }

  const chatSession = await bridge.status(botId, chatId);
  if (!chatSession?.session.codex) {
    throw new Error("Remote shell requires an attached Codex session.");
  }

  if (chatSession.session.codex.sandboxMode !== "danger-full-access") {
    throw new Error("Remote shell is allowed only when Codex sandbox is set to danger-full-access.");
  }

  return chatSession;
}

function parseCommand(text: string | undefined, headCount: number): { args: string[]; rest?: string } {
  const trimmed = text?.trim();
  if (!trimmed) {
    return { args: [] };
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { args: [] };
  }

  let remaining = trimmed.slice(firstSpace + 1).trim();
  if (!remaining) {
    return { args: [] };
  }

  if (headCount === 0) {
    return {
      args: [],
      rest: remaining || undefined,
    };
  }

  const args: string[] = [];
  for (let index = 0; index < headCount && remaining; index += 1) {
    const nextSpace = remaining.indexOf(" ");
    if (nextSpace === -1) {
      args.push(remaining);
      remaining = "";
      break;
    }

    args.push(remaining.slice(0, nextSpace));
    remaining = remaining.slice(nextSpace + 1).trim();
  }

  return {
    args,
    rest: remaining || undefined,
  };
}

function formatSecretHelp(): string {
  return [
    "Secret command guide",
    "",
    "Store sensitive values without exposing them to agents or chat output.",
    "",
    "Commands:",
    "```text",
    "/secret set KEY value",
    "/secret list",
    "/secret remove KEY",
    "```",
    "",
    "Example:",
    "```text",
    "/secret set GIFTISHOW_AUTH_KEY REAL...",
    "/secret set GIFTISHOW_TOKEN_KEY xNC...",
    "```",
    "",
    "Then tell the agent:",
    "```text",
    "기프티쇼 인증 정보는 secret에 저장했어.",
    "GIFTISHOW_AUTH_KEY, GIFTISHOW_TOKEN_KEY를 사용해서 설정/검증해줘.",
    "```",
    "",
    "Agents only see the key names. They can read values with:",
    "```text",
    "node \"$REMOTEAGENT_SECRET_BIN\" get <KEY>",
    "```",
    "If an agent obtains a new secret value such as an OAuth refresh token, it can delegate storage without printing the value:",
    "```text",
    "printf '%s' \"$VALUE\" | node \"$REMOTEAGENT_SECRET_BIN\" set <KEY>",
    "```",
  ].join("\n");
}

function formatRuntimeOptions(): string {
  return [
    "Runtime options",
    `- retry: ${formatRetryLimit(config.telegramAutoProgressMaxTurns)} (TELEGRAM_AUTO_PROGRESS_MAX_TURNS)`,
    `- timeout: ${formatTimeoutSeconds(config.commandTimeoutMs)} (COMMAND_TIMEOUT_MS)`,
    `- intent: ${formatRetryLimit(config.telegramUntaggedIntentRetries)} (TELEGRAM_UNTAGGED_INTENT_RETRIES)`,
    `- command-menu: ${config.telegramCommandMenuEnabled ? "on" : "off"} (TELEGRAM_COMMAND_MENU_ENABLED)`,
    "",
    "Usage:",
    "/option retry <count>",
    "/option timeout <seconds>",
    "/option intent <count>",
    "/option command-menu <on|off|refresh>",
    "",
    "`retry 0` disables the automatic continuation limit.",
    "`intent 0` disables untagged intent-only response retries.",
    "`command-menu refresh` reapplies Telegram slash-command autocomplete without changing the saved option.",
  ].join("\n");
}

function formatRetryLimit(value: number): string {
  return value === 0 ? "unlimited" : `${value}`;
}

function formatTimeoutSeconds(valueMs: number): string {
  return `${Math.round(valueMs / 1000)}s`;
}

async function upsertInstalledEnvValue(key: string, value: string): Promise<void> {
  if (!/^[A-Z0-9_]+$/.test(key)) {
    throw new Error(`Invalid environment key: ${key}`);
  }
  const envPath = path.join(config.dataDir, ".env");
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const existing = await fs.readFile(envPath, "utf8").catch(() => "");
  const lines = existing ? existing.split(/\r?\n/) : [];
  let updated = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!updated) {
    next.push(`${key}=${value}`);
  }
  await fs.writeFile(envPath, `${next.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

async function applyTelegramCommandMenuOption(enabled: boolean): Promise<{ summary: string }> {
  let applied = 0;
  const failures: string[] = [];

  for (const token of config.telegramBotTokens) {
    const botLabel = await resolveTelegramBotLabel(token).catch(() => "unknown-bot");
    try {
      if (enabled) {
        await setTelegramCommandMenu(token);
      } else {
        await deleteTelegramCommandMenu(token);
      }
      applied += 1;
    } catch (error) {
      failures.push(`${botLabel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const parts = [`applied=${applied}/${config.telegramBotTokens.length}`];
  if (failures.length > 0) {
    parts.push(`failed=${failures.length}`, ...failures.map((failure) => `- ${failure}`));
  }
  return { summary: parts.join("\n") };
}

async function resolveTelegramBotLabel(token: string): Promise<string> {
  const payload = await callTelegramApi<UserFromGetMe>(token, "getMe", {});
  return payload.username ? `@${payload.username}` : String(payload.id);
}

function chunkMessage(text: string, size: number): string[] {
  if (text.length <= size) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > size) {
    const slice = remaining.slice(0, size);
    const breakAt = slice.lastIndexOf("\n");
    const index = breakAt > size * 0.5 ? breakAt : size;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function flattenChunks(blocks: string[], size: number): string[] {
  return blocks.flatMap((block) => chunkMessage(block, size));
}

function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return ["read-only", "workspace-write", "danger-full-access"].includes(value);
}

function isRemoteShellMessage(text: string): boolean {
  return text.startsWith("/!");
}

function isRecognizedSlashCommand(text: string, botId: string): boolean {
  if (!text.startsWith("/")) {
    return false;
  }

  const token = text.slice(1).split(/\s+/, 1)[0]?.trim();
  if (!token) {
    return false;
  }

  if (token.includes("/")) {
    return false;
  }

  const [name, mention] = token.split("@", 2);
  if (!name) {
    return false;
  }

  if (mention && mention.toLowerCase() !== botId.toLowerCase()) {
    return false;
  }

  return RECOGNIZED_COMMANDS.has(name.toLowerCase());
}

function isUnsupportedSlashCommand(text: string, botId: string): boolean {
  if (!text.startsWith("/") || isRemoteShellMessage(text)) {
    return false;
  }

  const token = text.slice(1).split(/\s+/, 1)[0]?.trim();
  if (!token || token.includes("/")) {
    return false;
  }

  const [, mention] = token.split("@", 2);
  return !mention || mention.toLowerCase() === botId.toLowerCase();
}

function parseRemoteShellRequest(text: string): { kind: "native" | "cmd" | "bash"; command: string } | undefined {
  const body = text.slice(2).trim();
  if (!body) {
    return undefined;
  }

  if (body.startsWith("cmd ")) {
    const command = body.slice(4).trim();
    return command ? { kind: "cmd", command } : undefined;
  }

  if (body.startsWith("bash ")) {
    const command = body.slice(5).trim();
    return command ? { kind: "bash", command } : undefined;
  }

  return { kind: "native", command: body };
}

function formatRemoteShellResult(
  result: { shell: string; code: number | null; stdout: string; stderr: string },
  command: string,
  cwd: string,
): string {
  const parts = [
    `<b>[SHELL | ${escapeHtml(result.shell)} | exit ${escapeHtml(String(result.code ?? "unknown"))}]</b>`,
    `cwd: ${escapeHtml(cwd)}`,
    `$ ${escapeHtml(command)}`,
  ];

  if (result.stdout) {
    parts.push("<pre>");
    parts.push(escapeHtml(result.stdout));
    parts.push("</pre>");
  }

  if (result.stderr) {
    parts.push("<b>[stderr]</b>");
    parts.push("<pre>");
    parts.push(escapeHtml(result.stderr));
    parts.push("</pre>");
  }

  if (!result.stdout && !result.stderr) {
    parts.push("<pre>(no output)</pre>");
  }

  return parts.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sanitizeAttachmentResponseBlocks(blocks: string[]): string[] {
  const sanitized = blocks
    .map((block) => sanitizeAttachmentResponseText(block))
    .filter((block) => block.trim().length > 0);

  return sanitized.length > 0 ? sanitized : ["첨부는 받았습니다. 내부 경로는 숨기고 있습니다. 필요한 분석을 한 줄로 다시 보내 주세요."];
}

function sanitizeAttachmentResponseText(text: string): string {
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }

    if (/^A Telegram .* was saved locally\.$/.test(trimmed)) {
      return false;
    }
    if (trimmed === "Do not repeat internal metadata such as local file paths unless it is strictly necessary.") {
      return false;
    }
    if (trimmed.startsWith("Treat this caption as the user's instruction:")) {
      return false;
    }
    if (trimmed.startsWith("Attachment path for tool use:")) {
      return false;
    }
    if (trimmed === "File content preview:") {
      return false;
    }
    if (trimmed.startsWith("/home/")) {
      return false;
    }
    if (trimmed.includes(".remoteagent/uploads/telegram/")) {
      return false;
    }

    return true;
  });

  return filtered.join("\n").trim();
}

async function formatTelegramAttachmentPrompt(
  kind: string,
  filePath: string,
  caption: string | undefined,
  metadata?: {
    fileName?: string;
    mimeType?: string;
    isFallback?: boolean;
  },
): Promise<string> {
  const parts = [
    `A Telegram ${kind} was saved locally.`,
    "Do not repeat internal metadata such as local file paths unless it is strictly necessary.",
    metadata?.fileName ? `Original filename: ${metadata.fileName}` : undefined,
    metadata?.mimeType ? `Telegram MIME type: ${metadata.mimeType}` : undefined,
    metadata?.isFallback ? "This attachment was accepted through the generic fallback path. Inspect it from the saved file path and decide the right handling." : undefined,
    caption
      ? `Treat this caption as the user's instruction: ${caption}`
      : "If the user gave no caption, inspect the attachment and respond briefly with the useful result.",
    `Attachment path for tool use: ${filePath}`,
  ].filter(Boolean);

  const inlineText = await readInlineTextPreview(kind, filePath);
  if (inlineText) {
    parts.push("File content preview:");
    parts.push(inlineText);
  }

  return parts.join("\n");
}

function classifyTelegramDocument(
  mimeType: string | undefined,
  fileName: string | undefined,
): { kind: string; isFallback: boolean } {
  const lowerName = fileName?.toLowerCase() ?? "";

  if (mimeType?.startsWith("image/")) {
    return { kind: "image document", isFallback: false };
  }

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    return { kind: "PDF document", isFallback: false };
  }

  if (isWordDocument(mimeType, lowerName)) {
    return { kind: "Word document", isFallback: false };
  }

  if (isSpreadsheetDocument(mimeType, lowerName)) {
    return { kind: "Spreadsheet document", isFallback: false };
  }

  if (
    mimeType?.startsWith("text/")
    || mimeType === "application/markdown"
    || lowerName.endsWith(".txt")
    || lowerName.endsWith(".md")
    || lowerName.endsWith(".markdown")
  ) {
    return {
      kind: lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || mimeType === "text/markdown" || mimeType === "application/markdown"
        ? "Markdown document"
        : "text document",
      isFallback: false,
    };
  }

  if (isArchiveDocument(mimeType, lowerName)) {
    return { kind: "archive document", isFallback: false };
  }

  return { kind: "generic file", isFallback: true };
}

function isWordDocument(mimeType: string | undefined, lowerName: string): boolean {
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mimeType === "application/msword"
  ) {
    return true;
  }

  return lowerName.endsWith(".docx") || lowerName.endsWith(".doc");
}

function isSpreadsheetDocument(mimeType: string | undefined, lowerName: string): boolean {
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || mimeType === "application/vnd.ms-excel"
    || mimeType === "application/vnd.ms-excel.sheet.macroenabled.12"
  ) {
    return true;
  }

  return lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls") || lowerName.endsWith(".xlsm");
}

function isArchiveDocument(mimeType: string | undefined, lowerName: string): boolean {
  const archiveMimeTypes = new Set([
    "application/zip",
    "application/x-zip-compressed",
    "application/x-tar",
    "application/gzip",
    "application/x-gzip",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-rar-compressed",
    "application/x-bzip2",
    "application/x-xz",
  ]);
  if (mimeType && archiveMimeTypes.has(mimeType)) {
    return true;
  }

  return [
    ".zip",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".gz",
    ".7z",
    ".rar",
    ".bz2",
    ".xz",
  ].some((extension) => lowerName.endsWith(extension));
}

async function readInlineTextPreview(kind: string, filePath: string): Promise<string | undefined> {
  if (kind === "Word document") {
    return readWordDocumentPreview(filePath);
  }

  if (kind === "Spreadsheet document") {
    return readSpreadsheetDocumentPreview(filePath);
  }

  if (!["text document", "Markdown document"].includes(kind)) {
    return undefined;
  }

  const maxChars = 20_000;
  const text = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (!text) {
    return undefined;
  }

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} more chars in local file]`;
}

async function readWordDocumentPreview(filePath: string): Promise<string | undefined> {
  if (!filePath.toLowerCase().endsWith(".docx")) {
    return undefined;
  }

  const python = `
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_CHARS = 20000
path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    xml_bytes = archive.read("word/document.xml")
root = ET.fromstring(xml_bytes)
text = "".join(node.text or "" for node in root.iter() if node.tag.endswith("}t"))
text = re.sub(r"\\s+", " ", text).strip()
if len(text) > MAX_CHARS:
    text = text[:MAX_CHARS] + f"\\n\\n[truncated: {len(text) - MAX_CHARS} more chars in local file]"
print(text)
`.trim();

  const { stdout } = await execFileAsync("python3", ["-c", python, filePath], { maxBuffer: 1024 * 1024 });
  const preview = stdout.trim();
  return preview || undefined;
}

async function readSpreadsheetDocumentPreview(filePath: string): Promise<string | undefined> {
  const lowerPath = filePath.toLowerCase();
  if (!lowerPath.endsWith(".xlsx") && !lowerPath.endsWith(".xlsm")) {
    return undefined;
  }

  const python = `
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_CHARS = 20000
MAX_ROWS = 120
MAX_CELLS = 500
path = sys.argv[1]
ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
shared_strings = []
rows = []
cell_count = 0

with zipfile.ZipFile(path) as archive:
    if "xl/sharedStrings.xml" in archive.namelist():
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        for si in shared_root.findall("a:si", ns):
            parts = [node.text or "" for node in si.iter() if node.tag.endswith("}t")]
            shared_strings.append("".join(parts))

    worksheet_names = sorted(
        name for name in archive.namelist()
        if name.startswith("xl/worksheets/") and name.endswith(".xml")
    )

    for worksheet_name in worksheet_names:
        sheet_root = ET.fromstring(archive.read(worksheet_name))
        for row in sheet_root.findall(".//a:sheetData/a:row", ns):
            values = []
            for cell in row.findall("a:c", ns):
                cell_type = cell.get("t")
                if cell_type == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
                else:
                    value_node = cell.find("a:v", ns)
                    if value_node is None or value_node.text is None:
                        continue
                    raw_value = value_node.text
                    if cell_type == "s":
                        try:
                            value = shared_strings[int(raw_value)]
                        except Exception:
                            value = raw_value
                    else:
                        value = raw_value
                value = re.sub(r"\\s+", " ", value).strip()
                if not value:
                    continue
                values.append(value)
                cell_count += 1
                if cell_count >= MAX_CELLS:
                    break
            if values:
                rows.append("\t".join(values))
                if len(rows) >= MAX_ROWS or cell_count >= MAX_CELLS:
                    break
        if len(rows) >= MAX_ROWS or cell_count >= MAX_CELLS:
            break

text = "\\n".join(rows).strip()
if len(text) > MAX_CHARS:
    text = text[:MAX_CHARS] + f"\\n\\n[truncated: {len(text) - MAX_CHARS} more chars in local file]"
print(text)
`.trim();

  const { stdout } = await execFileAsync("python3", ["-c", python, filePath], { maxBuffer: 1024 * 1024 });
  const preview = stdout.trim();
  return preview || undefined;
}
type TelegramMessageOptions = {
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
};

type TelegramOutgoingDocument = {
  path: string;
  caption?: string;
};

type TelegramMessageResult = {
  message_id: number;
};

type TelegramGetFileResult = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
};

async function downloadTelegramFile(
  botToken: string,
  botId: string,
  chatId: string,
  fileId: string,
  preferredName?: string,
): Promise<{ path: string }> {
  const file = await callTelegramApi<TelegramGetFileResult>(botToken, "getFile", {
    file_id: fileId,
  });
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path for the attachment.");
  }

  const directory = path.join(config.dataDir, "uploads", "telegram", safePathSegment(botId), safePathSegment(chatId));
  await fs.mkdir(directory, { recursive: true });

  const extension = path.extname(file.file_path) || path.extname(preferredName ?? "") || ".bin";
  const basename = path.basename(preferredName ?? file.file_path, path.extname(preferredName ?? file.file_path));
  const outputPath = path.join(directory, `${Date.now()}-${safePathSegment(basename)}-${randomUUID()}${extension}`);
  const fileUrl = new URL(file.file_path, `https://api.telegram.org/file/bot${botToken}/`).toString();

  const { stderr } = await execFileAsync("curl", [
    "-fL",
    "-sS",
    "--max-time",
    "60",
    "-o",
    outputPath,
    fileUrl,
  ]);
  if (stderr?.trim()) {
    console.error(`curl stderr for Telegram file download: ${stderr.trim()}`);
  }

  return { path: outputPath };
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "file";
}

async function normalizeTelegramDelivery(chunks: string[]): Promise<{ chunks: string[]; documents: TelegramOutgoingDocument[] }> {
  const documents = new Map<string, TelegramOutgoingDocument>();
  const normalizedChunks = await Promise.all(chunks.map(async (chunk) => {
    const lines = chunk.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
    const kept: string[] = [];

    for (const line of lines) {
      const match = /^TELEGRAM_FILE:\s*(.+?)\s*$/i.exec(line.trim());
      if (!match) {
        kept.push(line);
        continue;
      }

      const candidatePath = match[1];
      if (await isReadableTelegramDocument(candidatePath)) {
        documents.set(candidatePath, { path: candidatePath });
      } else {
        kept.push(`Telegram file was requested but is missing: ${candidatePath}`);
      }
    }

    return kept.join("\n").trim();
  }));

  return {
    chunks: normalizedChunks.filter(Boolean),
    documents: [...documents.values()],
  };
}

async function isReadableTelegramDocument(filePath: string): Promise<boolean> {
  if (!path.isAbsolute(filePath)) {
    return false;
  }

  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function sendTelegramDocuments(
  botToken: string,
  chatId: number,
  documents: TelegramOutgoingDocument[],
): Promise<void> {
  for (const document of documents) {
    await sendTelegramDocument(botToken, chatId, document);
  }
}

async function sendTelegramDocument(
  botToken: string,
  chatId: number,
  document: TelegramOutgoingDocument,
): Promise<TelegramMessageResult> {
  const resolvedPath = path.resolve(document.path);
  if (!(await isReadableTelegramDocument(resolvedPath))) {
    throw new Error(`Telegram document is missing or unreadable: ${resolvedPath}`);
  }

  const args = [
    "-sS",
    "--max-time",
    "120",
    "-F",
    `chat_id=${chatId}`,
    "-F",
    `document=@${resolvedPath}`,
    `https://api.telegram.org/bot${botToken}/sendDocument`,
  ];

  if (document.caption?.trim()) {
    args.splice(args.length - 1, 0, "-F", `caption=${document.caption.trim()}`);
  }

  const { stdout, stderr } = await execFileAsync("curl", args);
  if (stderr?.trim()) {
    console.error(`curl stderr for sendDocument: ${stderr.trim()}`);
  }

  const payload = JSON.parse(stdout) as { ok?: boolean; result?: TelegramMessageResult; description?: string };
  if (!payload.ok || !payload.result) {
    throw new Error(payload.description || "Telegram API sendDocument failed.");
  }

  return payload.result;
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  extra?: TelegramMessageOptions,
): Promise<TelegramMessageResult> {
  const startedAt = Date.now();
  try {
    return await callTelegramApi<TelegramMessageResult>(botToken, "sendMessage", {
      chat_id: String(chatId),
      text,
      parse_mode: extra?.parse_mode,
    });
  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 3000) {
      console.warn(`[telegram-sendMessage-slow] chat=${chatId} elapsedMs=${elapsedMs} chars=${text.length}`);
    }
  }
}

async function sendTelegramChatAction(
  botToken: string,
  chatId: number,
  action: "typing",
): Promise<void> {
  await callTelegramApi<boolean>(botToken, "sendChatAction", {
    chat_id: String(chatId),
    action,
  });
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  params: Record<string, string | undefined>,
): Promise<T> {
  const args = [
    "-sS",
    "--max-time",
    "35",
    `https://api.telegram.org/bot${botToken}/${method}`,
  ];

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      args.push("--data-urlencode", `${key}=${value}`);
    }
  }

  const { stdout, stderr } = await execFileAsync("curl", args);
  if (stderr?.trim()) {
    console.error(`curl stderr for ${method}: ${stderr.trim()}`);
  }

  const payload = JSON.parse(stdout) as { ok?: boolean; result?: T; description?: string };
  if (!payload.ok) {
    throw new TelegramApiError(method, payload.description || `Telegram API ${method} failed.`);
  }

  return payload.result as T;
}

class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly description: string,
  ) {
    super(description);
    this.name = "TelegramApiError";
  }
}

function isTelegramForbiddenError(error: unknown): boolean {
  if (error instanceof GrammyError) {
    return error.error_code === 403 || /^Forbidden:/i.test(error.description);
  }
  if (error instanceof TelegramApiError) {
    return /^Forbidden:/i.test(error.description);
  }
  return error instanceof Error && /^Forbidden:/i.test(error.message);
}
