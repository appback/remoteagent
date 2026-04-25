import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { config } from "./config.js";
import { BridgeService } from "./services/bridge-service.js";
import { ProviderSetupService } from "./services/provider-setup-service.js";
import { RemoteShellService } from "./services/remote-shell-service.js";
import type { ChatSession, CodexSandboxMode, Provider } from "./types.js";
import type { UserFromGetMe } from "grammy/types";

const execFileAsync = promisify(execFile);

const HELP_TEXT = [
  "Commands:",
  "/start [codex|claude] [path]",
  "/help",
  "/list",
  "/new [path]",
  "/switch <session>",
  "/batch start|send|cancel|status",
  "/attach codex <thread_id>",
  "/attach claude <session_id>",
  "/sandbox codex <read-only|workspace-write|danger-full-access>",
  "/status",
  "/install codex|claude",
  "/login claude [token]",
  "/reset",
  "/! <command>",
  "/!cmd <command>",
  "/!bash <command>",
].join("\n");

export function createBot(token: string, bridge: BridgeService, botInfo: UserFromGetMe): Bot {
  const bot = new Bot(token, { botInfo });
  const shellService = new RemoteShellService(config.commandTimeoutMs);
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
      await runWithPendingAnimation(target.botToken, target.telegramChatId, async () => {
        const responses = await bridge.routeMessage(botId, chatId, text);
        return {
          chunks: flattenChunks(bridge.formatResponses(responses), 3900),
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
    console.log(
      `[tg-update] bot=${getBotId()} kind=${updateKind} chat=${ctx.chat?.id ?? "?"} text=${JSON.stringify(text).slice(0, 240)}`,
    );
    await next();
  });

  bot.command("start", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args, rest } = parseCommand(ctx.message?.text, 1);
    const first = args[0]?.trim();
    const explicitProvider = first && (["codex", "claude"] as const).includes(first.toLowerCase() as Provider)
      ? first.toLowerCase() as Provider
      : undefined;
    const workspace = explicitProvider
      ? rest
      : [first, rest].filter((value): value is string => Boolean(value)).join(" ") || undefined;

    const provider = await bridge.resolveStartProvider(explicitProvider);
    const mapping = await bridge.startSession(botId, chatId, provider, workspace);
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
      bridge.listSessions(),
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

  bot.command("status", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(botId, chatId);
    await reply(ctx, bridge.formatStatus(mapping));
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

    if (provider !== "claude") {
      await reply(ctx, "Usage: `/login claude` or `/login claude <token>`", { parse_mode: "Markdown" });
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
      await runWithPendingAnimation(token, ctx.chat.id, async () => {
        const responses = await bridge.routeMessage(botId, chatId, message);
        return {
          chunks: flattenChunks(sanitizeAttachmentResponseBlocks(bridge.formatResponses(responses)), 3900),
        };
      });
      return;
    }

    if (document) {
      const attachmentKind = classifyTelegramDocument(document.mime_type, document.file_name);
      if (attachmentKind) {
        const downloaded = await downloadTelegramFile(token, botId, chatId, document.file_id, document.file_name);
        const message = await formatTelegramAttachmentPrompt(attachmentKind, downloaded.path, ctx.message.caption?.trim());

        await bridge.logSystem(botId, chatId, `Telegram ${attachmentKind} received: ${downloaded.path}`);
        await runWithPendingAnimation(token, ctx.chat.id, async () => {
          const responses = await bridge.routeMessage(botId, chatId, message);
          return {
            chunks: flattenChunks(sanitizeAttachmentResponseBlocks(bridge.formatResponses(responses)), 3900),
          };
        });
        return;
      }
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
      await runWithPendingAnimation(token, ctx.chat.id, async () => {
        const responses = await bridge.routeMessage(botId, chatId, message);
        return {
          chunks: flattenChunks(sanitizeAttachmentResponseBlocks(bridge.formatResponses(responses)), 3900),
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

    if (text.startsWith("/")) {
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
      await sendTelegramMessage(target.botToken, target.telegramChatId, message).catch(() => undefined);
    }
  }

  private key(botId: string, chatId: string): string {
    return `${botId}:${chatId}`;
  }
}

async function runWithPendingAnimation(
  botToken: string,
  chatId: number,
  task: () => Promise<{ chunks: string[]; parseMode?: "HTML" | "MarkdownV2" }>,
): Promise<void> {
  const pending = await sendTelegramMessage(botToken, chatId, "Working.");
  const pendingFrames = ["Working.", "Working..", "Working...", "Working...."];
  let pendingIndex = 0;
  const pendingLoop = setInterval(() => {
    pendingIndex = (pendingIndex + 1) % pendingFrames.length;
    void editTelegramMessageText(botToken, chatId, pending.message_id, pendingFrames[pendingIndex]).catch(() => undefined);
  }, 3000);

  try {
    const result = await task();
    const chunks = result.chunks;
    const extra = result.parseMode ? { parse_mode: result.parseMode } : undefined;

    if (chunks.length === 0) {
      await editTelegramMessageText(botToken, chatId, pending.message_id, "Response was empty.");
      return;
    }

    await deleteTelegramMessage(botToken, chatId, pending.message_id).catch(() => undefined);
    for (const chunk of chunks) {
      await sendTelegramMessage(botToken, chatId, chunk, extra);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    await editTelegramMessageText(botToken, chatId, pending.message_id, message).catch(async () => {
      await sendTelegramMessage(botToken, chatId, message);
    });
  } finally {
    clearInterval(pendingLoop);
  }
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

async function formatTelegramAttachmentPrompt(kind: string, filePath: string, caption: string | undefined): Promise<string> {
  const parts = [
    `A Telegram ${kind} was saved locally.`,
    "Do not repeat internal metadata such as local file paths unless it is strictly necessary.",
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

function classifyTelegramDocument(mimeType: string | undefined, fileName: string | undefined): string | undefined {
  const lowerName = fileName?.toLowerCase() ?? "";

  if (mimeType?.startsWith("image/")) {
    return "image document";
  }

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    return "PDF document";
  }

  if (
    mimeType?.startsWith("text/")
    || mimeType === "application/markdown"
    || lowerName.endsWith(".txt")
    || lowerName.endsWith(".md")
    || lowerName.endsWith(".markdown")
  ) {
    return lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || mimeType === "text/markdown" || mimeType === "application/markdown"
      ? "Markdown document"
      : "text document";
  }

  if (isArchiveDocument(mimeType, lowerName)) {
    return "archive document";
  }

  return undefined;
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

type TelegramMessageOptions = {
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
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
