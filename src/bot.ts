import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { config } from "./config.js";
import { BridgeService } from "./services/bridge-service.js";
import { BotManagementService } from "./services/bot-management-service.js";
import { ProviderSetupService } from "./services/provider-setup-service.js";
import { RemoteShellService } from "./services/remote-shell-service.js";
import type { ChatSession, CodexSandboxMode, Provider } from "./types.js";
import type { UserFromGetMe } from "grammy/types";

const execFileAsync = promisify(execFile);

const HELP_TEXT = [
  "Commands:",
  "/start [codex|claude]",
  "/help",
  "/list",
  "/new",
  "/switch <session>",
  "/batch start|send|cancel|status",
  "/attach codex <thread_id>",
  "/attach claude <session_id>",
  "/model [name]",
  "/stop",
  "/sandbox codex <read-only|workspace-write|danger-full-access>",
  "/status",
  "/reportbot list|set <target>|status|clear",
  "/bots",
  "/bot add general|report <token>",
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
  "Do not claim that a Telegram message or file was sent unless RemoteAgent explicitly confirmed that delivery step.",
  "If you want RemoteAgent to send a file, include a separate line exactly like: TELEGRAM_FILE: /absolute/path/to/file",
  "Do not call Telegram APIs directly or use bot credentials even if they appear to exist in the environment.",
  "If this session has an approved Telegram report target, background jobs may report through the helper command: node \"$REMOTEAGENT_REPORT_BIN\" --session \"$REMOTEAGENT_PUBLIC_SESSION_ID\" \"message\"",
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
  "reportbot",
  "bots",
  "bot",
  "install",
  "login",
  "reset",
]);

const REPORT_CONTINUE_PROMPT = [
  "Continue the same task now.",
  "Do more concrete work before replying again.",
  "Do not restate the plan unless it changed because of a real finding.",
  "Reply again with exactly one first line: REPORT:progress or REPORT:result or REPORT:blocked.",
].join("\n");

class AutoContinueController {
  private readonly stops = new Set<string>();

  requestStop(botId: string, chatId: string): void {
    this.stops.add(this.key(botId, chatId));
  }

  clear(botId: string, chatId: string): void {
    this.stops.delete(this.key(botId, chatId));
  }

  isStopRequested(botId: string, chatId: string): boolean {
    return this.stops.has(this.key(botId, chatId));
  }

  private key(botId: string, chatId: string): string {
    return `${botId}:${chatId}`;
  }
}

export function createBot(token: string, bridge: BridgeService, botManagement: BotManagementService, botInfo: UserFromGetMe): Bot {
  const bot = new Bot(token, { botInfo });
  const autoContinue = new AutoContinueController();
  const shellService = new RemoteShellService(config.commandTimeoutMs);
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
          ),
        };
      });
    },
  );
  const getBotId = (): string => bot.botInfo?.username ?? String(bot.botInfo?.id ?? token);
  const reply = async (ctx: Context, text: string, extra?: TelegramMessageOptions): Promise<TelegramMessageResult> => {
    if (!ctx.chat) {
      throw new Error("Telegram chat context is missing.");
    }
    return sendTelegramMessage(token, ctx.chat.id, text, extra);
  };

  bot.use(async (ctx, next) => {
    const updateKind = Object.keys(ctx.update).join(",");
    const text = ctx.message?.text ?? ctx.editedMessage?.text ?? ctx.channelPost?.text ?? "";
    const safeText = sanitizeLoggedTelegramText(text);
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
    const [mapping, sessions] = await Promise.all([
      bridge.status(botId, chatId),
      bridge.listSessions(botId),
    ]);
    await reply(ctx, bridge.formatSessionList(sessions, mapping?.session.sessionId));
  };

  bot.command("list", async (ctx) => {
    await replySessionList(ctx);
  });

  bot.command("new", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { rest } = parseCommand(ctx.message?.text, 0);
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

    const mapping = await bridge.switchSession(botId, chatId, sessionId);
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
    autoContinue.requestStop(botId, chatId);
    const result = await bridge.stopActiveRun(botId, chatId);
    await bridge.logSystem(botId, chatId, "Stop requested for auto-continue.");
    await reply(
      ctx,
      result.stopped
        ? `Stop requested. Active work for ${result.sessionPublicId ?? "this session"} was interrupted, and further automatic continuation will stop.`
        : "Stop requested. No active provider process was running, but further automatic continuation will stop.",
    );
  });

  bot.command("status", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(botId, chatId);
    await reply(ctx, bridge.formatStatus(mapping));
  });

  bot.command("reportbot", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 2);
    const action = args[0]?.toLowerCase();
    const target = args[1]?.trim();
    const reportBotIds = config.telegramBotTokens
      .map((token, index) => ({ token, role: config.telegramBotRoles[index] }))
      .filter((entry) => entry.role === "report")
      .map((entry) => entry.token.split(":", 1)[0] ?? "");

    if (!action || !["list", "set", "status", "clear"].includes(action)) {
      await reply(ctx, "Usage: `/reportbot list`, `/reportbot set <number|@bot_username>`, `/reportbot status`, or `/reportbot clear`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (action === "list") {
      const contacts = await bridge.listTelegramReportTargets(config.telegramOwnerId, reportBotIds);
      await reply(ctx, bridge.formatTelegramReportTargets(contacts));
      return;
    }

    if (action === "status") {
      const mapping = await bridge.status(botId, chatId);
      await reply(ctx, mapping ? bridge.formatCurrentSession(mapping) : "No paired session for this chat yet.");
      return;
    }

    if (action === "clear") {
      const mapping = await bridge.clearTelegramReportTarget(botId, chatId);
      await reply(ctx, `Cleared the Telegram report target for ${mapping.session.publicId}.\n\n${bridge.formatCurrentSession(mapping)}`);
      return;
    }

    if (!target) {
      await reply(ctx, "Usage: `/reportbot set <number|@bot_username>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.setTelegramReportTargetBySelector(
      botId,
      chatId,
      target,
      config.telegramOwnerId,
      reportBotIds,
    );
    await reply(
      ctx,
      `Saved the report target for ${mapping.session.publicId}.\n\n${bridge.formatCurrentSession(mapping)}`,
    );
  });

  bot.command("bots", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    await reply(ctx, await botManagement.listBots());
  });

  bot.command("bot", async (ctx) => {
    await ensureOwnerControlAccess(ctx);
    const sourceBotId = getBotId();
    const { args, rest } = parseCommand(ctx.message?.text, 2);
    const action = args[0]?.toLowerCase();

    if (!action || !["add", "remove", "reload"].includes(action)) {
      await reply(ctx, "Usage: `/bot add general <token>`, `/bot add report <token>`, `/bot remove <username|id>`, or `/bot reload`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (action === "add") {
      const role = args[1]?.toLowerCase();
      if (role !== "general" && role !== "report") {
        await reply(ctx, "Usage: `/bot add general <token>` or `/bot add report <token>`", {
          parse_mode: "Markdown",
        });
        return;
      }
      const result = await botManagement.addBot(role, rest?.trim() ?? "", sourceBotId, sourceBotToken, ctx.chat.id);
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

    if (photo) {
      const downloaded = await downloadTelegramFile(token, botId, chatId, photo.file_id, "telegram-photo.jpg");
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
            sanitizeAttachmentResponseBlocks,
          ),
        };
      });
      return;
    }

    if (document) {
      const attachment = classifyTelegramDocument(document.mime_type, document.file_name);
      const downloaded = await downloadTelegramFile(token, botId, chatId, document.file_id, document.file_name);
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
            sanitizeAttachmentResponseBlocks,
          ),
        };
      });
      return;
    }

    const text = ctx.message.text?.trim();
    if (!text) {
      return;
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

    if (isRecognizedSlashCommand(text, botId)) {
      return;
    }

    await bridge.logSystem(botId, chatId, `Telegram text received (${text.length} chars).`);
    await messageBatcher.enqueue({ botToken: token, telegramChatId: ctx.chat.id }, botId, chatId, text);
  });

  bot.catch((error) => {
    const ctx = error.ctx;
    console.error(`Telegram update ${ctx.update.update_id} failed`);

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
    return trimmed.replace(/^(\/bot\s+add\s+\S+)\s+.+$/i, "$1 [redacted]");
  }
  if (/^\/login\s+claude\s+/i.test(trimmed)) {
    return "/login claude [redacted]";
  }
  return text;
}

async function runWithPendingAnimation(
  botToken: string,
  chatId: number,
  task: (helpers: PendingAnimationHelpers) => Promise<{ chunks: string[]; parseMode?: "HTML" | "MarkdownV2" }>,
): Promise<void> {
  let pending = await sendTelegramMessage(botToken, chatId, "Working.");
  const pendingFrames = ["Working.", "Working..", "Working...", "Working...."];
  let pendingIndex = 0;
  const pendingLoop = setInterval(() => {
    pendingIndex = (pendingIndex + 1) % pendingFrames.length;
    void editTelegramMessageText(botToken, chatId, pending.message_id, pendingFrames[pendingIndex]).catch(() => undefined);
  }, 3000);

  try {
    const helpers: PendingAnimationHelpers = {
      reportProgress: async (chunks, parseMode) => {
        const normalized = await normalizeTelegramDelivery(chunks);
        const progressChunks = flattenChunks(normalized.chunks, 3900);
        if (progressChunks.length === 0 && normalized.documents.length === 0) {
          return;
        }

        const extra = parseMode ? { parse_mode: parseMode } : undefined;
        await deleteTelegramMessage(botToken, chatId, pending.message_id).catch(() => undefined);
        for (const chunk of progressChunks) {
          await sendTelegramMessage(botToken, chatId, chunk, extra);
        }
        if (normalized.documents.length > 0) {
          await sendTelegramDocuments(botToken, chatId, normalized.documents);
        }
        pending = await sendTelegramMessage(botToken, chatId, "Working.");
      },
    };

    const result = await task(helpers);
    const normalized = await normalizeTelegramDelivery(result.chunks);
    const chunks = flattenChunks(normalized.chunks, 3900);
    const extra = result.parseMode ? { parse_mode: result.parseMode } : undefined;

    if (chunks.length === 0 && normalized.documents.length === 0) {
      await editTelegramMessageText(botToken, chatId, pending.message_id, "Response was empty.");
      return;
    }

    await deleteTelegramMessage(botToken, chatId, pending.message_id).catch(() => undefined);
    for (const chunk of chunks) {
      await sendTelegramMessage(botToken, chatId, chunk, extra);
    }
    if (normalized.documents.length > 0) {
      await sendTelegramDocuments(botToken, chatId, normalized.documents);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    console.error(`[telegram-pending] chat=${chatId} failed: ${message}`, error);
    await editTelegramMessageText(botToken, chatId, pending.message_id, message).catch(async () => {
      await sendTelegramMessage(botToken, chatId, message);
    });
  } finally {
    clearInterval(pendingLoop);
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
  transform: (blocks: string[]) => string[] = (blocks) => blocks,
): Promise<string[]> {
  autoContinue.clear(botId, chatId);
  let prompt = appendReportProtocol(message);
  const maxTurns = config.telegramAutoProgressMaxTurns;
  const emptyResponseRetries = config.telegramEmptyResponseRetries;
  const retryableErrorRetries = config.telegramRetryableErrorRetries;
  const retryableErrorDelayMs = config.telegramRetryableErrorDelayMs;
  let emptyResponseRetryCount = 0;
  let retryableErrorCount = 0;
  let deliveredProgressCount = 0;

  for (let turn = 1; ; turn += 1) {
    if (typeof maxTurns === "number" && maxTurns > 0 && turn > maxTurns) {
      const limitMessage = `Automatic continue limit (${maxTurns}) reached before a final result.`;
      await bridge.logSystem(botId, chatId, limitMessage);
      autoContinue.clear(botId, chatId);
      return [limitMessage];
    }

    if (autoContinue.isStopRequested(botId, chatId)) {
      const stopMessage = "Automatic continuation stopped.";
      await bridge.logSystem(botId, chatId, stopMessage);
      autoContinue.clear(botId, chatId);
      return [stopMessage];
    }

    const turnLabel = `${label} turn ${turn}`;
    await bridge.logSystem(botId, chatId, `${turnLabel} started.`);

    try {
      const responses = await bridge.routeMessage(botId, chatId, prompt);
      const parsed = parseReportResponses(bridge.formatResponses(responses), transform);
      await bridge.logSystem(botId, chatId, `${turnLabel} returned ${parsed.kind}.`);
      emptyResponseRetryCount = 0;
      retryableErrorCount = 0;

      if (parsed.kind === "progress") {
        deliveredProgressCount += 1;
        await helpers.reportProgress(parsed.chunks);
        if (autoContinue.isStopRequested(botId, chatId)) {
          const stopMessage = "Automatic continuation stopped after the latest progress report.";
          await bridge.logSystem(botId, chatId, stopMessage);
          autoContinue.clear(botId, chatId);
          return [stopMessage];
        }
        prompt = REPORT_CONTINUE_PROMPT;
        continue;
      }

      if (parsed.kind === "result" || parsed.kind === "blocked") {
        autoContinue.clear(botId, chatId);
        return parsed.chunks;
      }

      await bridge.logSystem(botId, chatId, `${turnLabel} returned an untagged response; treating it as final output.`);
      autoContinue.clear(botId, chatId);
      return parsed.chunks;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "An unexpected error occurred.";
      const retryable = classifyRetryableProviderIssue(messageText, retryableErrorDelayMs);

      if (isEmptyResponseError(messageText) && emptyResponseRetryCount < emptyResponseRetries) {
        emptyResponseRetryCount += 1;
        const retryMessage = `${turnLabel} returned an empty response; retrying automatic continuation (${emptyResponseRetryCount}/${emptyResponseRetries}).`;
        console.warn(`[telegram-route] bot=${botId} chat=${chatId} ${retryMessage}`);
        await bridge.logSystem(botId, chatId, retryMessage);
        prompt = REPORT_CONTINUE_PROMPT;
        continue;
      }

      if (retryable && retryableErrorCount < retryableErrorRetries) {
        retryableErrorCount += 1;
        const retryMessage = formatRetryableProviderRetryMessage(retryable, retryableErrorCount, retryableErrorRetries);
        console.warn(`[telegram-route] bot=${botId} chat=${chatId} ${turnLabel} retrying: ${messageText}`);
        await bridge.logSystem(botId, chatId, `${turnLabel} retrying after temporary provider issue: ${messageText}`);
        await helpers.reportProgress([retryMessage]);
        if (autoContinue.isStopRequested(botId, chatId)) {
          const stopMessage = "Automatic continuation stopped after the latest retry notice.";
          await bridge.logSystem(botId, chatId, stopMessage);
          autoContinue.clear(botId, chatId);
          return [stopMessage];
        }
        await sleep(retryable.retryAfterMs);
        prompt = REPORT_CONTINUE_PROMPT;
        continue;
      }

      console.error(`[telegram-route] bot=${botId} chat=${chatId} ${turnLabel} failed: ${messageText}`, error);
      await bridge.logSystem(botId, chatId, `${turnLabel} failed: ${messageText}`);
      autoContinue.clear(botId, chatId);

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

type ReportKind = "progress" | "result" | "blocked" | "unknown";
type RetryableProviderIssueKind = "capacity" | "timeout" | "empty-response";

type RetryableProviderIssue = {
  kind: RetryableProviderIssueKind;
  retryAfterMs: number;
};

function appendReportProtocol(message: string): string {
  return `${message}\n\n${REPORT_PROTOCOL_PROMPT}`;
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
    const header = lines.shift() ?? "";
    const first = (lines.shift() ?? "").trim();
    const match = /^REPORT:(progress|result|blocked)$/i.exec(first);
    let kind = (match?.[1]?.toLowerCase() as ReportKind | undefined) ?? "unknown";
    const body = lines.join("\n").trim();
    if ((kind === "progress" || kind === "result") && looksLikeBlockedBody(body)) {
      kind = "blocked";
    }
    return {
      kind,
      text: body ? `${header}\n${body}` : "",
    };
  });

  const kind = parsedBlocks[0]?.kind ?? "unknown";
  const chunks = transform(parsedBlocks.map((item) => item.text));
  return { kind, chunks };
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

  if (/timed out after/i.test(message)) {
    return { kind: "timeout", retryAfterMs };
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
      return `일시적인 장애로 인해 ${waitSeconds}초 후 다시 시도합니다. (${attempt}/${maxAttempts})`;
    case "timeout":
      return `응답이 지연되어 ${waitSeconds}초 후 다시 시도합니다. (${attempt}/${maxAttempts})`;
    case "empty-response":
      return `후속 응답이 비어 있어 ${waitSeconds}초 후 다시 시도합니다. (${attempt}/${maxAttempts})`;
  }
}

function formatRetryableProviderFinalMessage(issue: RetryableProviderIssue): string {
  switch (issue.kind) {
    case "capacity":
      return "일시적인 장애가 반복되어 자동 재시도를 중단했습니다. 잠시 후 다시 시도하거나 다른 모델로 변경해 주세요.";
    case "timeout":
      return "응답 지연이 반복되어 자동 재시도를 중단했습니다. 잠시 후 다시 시도해 주세요.";
    case "empty-response":
      return "후속 응답이 반복해서 비어 자동 재시도를 중단했습니다. 같은 세션에서 다시 시도해 주세요.";
  }
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

  const nonEmptyChunks = normalizedChunks.filter(Boolean);
  if (documents.size === 0 && nonEmptyChunks.some((chunk) => mentionsTelegramDeliveryClaim(chunk))) {
    throw new Error("\ubaa8\ub378\uc774 \ud154\ub808\uadf8\ub7a8 \uc804\uc1a1 \uc644\ub8cc\ub97c \uc8fc\uc7a5\ud588\uc9c0\ub9cc, RemoteAgent\uac00 \ud655\uc778\ud55c \ud30c\uc77c \uc804\uc1a1 \uc9c0\uc2dc(`TELEGRAM_FILE: /absolute/path/to/file`)\ub294 \ud3ec\ud568\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4. \ud30c\uc77c\uc744 \ubcf4\ub0b4\ub824\uba74 \ud574\ub2f9 \ud615\uc2dd\uc73c\ub85c \uc808\ub300 \uacbd\ub85c\ub97c \uba85\uc2dc\ud574\uc57c \ud569\ub2c8\ub2e4.");
  }

  return {
    chunks: nonEmptyChunks,
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

function mentionsTelegramDeliveryClaim(text: string): boolean {
  return /(telegram).*(sent|delivered|delivery)|((sent|delivered|delivery).*(telegram))/i.test(text);
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
  return callTelegramApi<TelegramMessageResult>(botToken, "sendMessage", {
    chat_id: String(chatId),
    text,
    parse_mode: extra?.parse_mode,
  });
}

async function editTelegramMessageText(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  extra?: TelegramMessageOptions,
): Promise<void> {
  await callTelegramApi(botToken, "editMessageText", {
    chat_id: String(chatId),
    message_id: String(messageId),
    text,
    parse_mode: extra?.parse_mode,
  });
}

async function deleteTelegramMessage(botToken: string, chatId: number, messageId: number): Promise<void> {
  await callTelegramApi(botToken, "deleteMessage", {
    chat_id: String(chatId),
    message_id: String(messageId),
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
    throw new Error(payload.description || `Telegram API ${method} failed.`);
  }

  return payload.result as T;
}
