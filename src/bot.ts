import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { config } from "./config.js";
import { BridgeService } from "./services/bridge-service.js";
import { RemoteShellService } from "./services/remote-shell-service.js";
import { telegramFetch } from "./telegram-fetch.js";
import type { BridgeMode, ChatSession, CodexSandboxMode, Provider } from "./types.js";

const HELP_TEXT = [
  "Commands:",
  "/session",
  "/sessions",
  "/list",
  "/new [path]",
  "/switch <session>",
  "/batch start|send|cancel|status",
  "/startpair codex [path]",
  "/startpair claude [path]",
  "/startpair both [path]",
  "/attach codex <thread_id> [path]",
  "/attach claude <session_id> [path]",
  "/sandbox codex <read-only|workspace-write|danger-full-access>",
  "/status",
  "/mode codex",
  "/mode claude",
  "/mode compare",
  "/reset",
  "/! <command>",
  "/!cmd <command>",
  "/!bash <command>",
].join("\n");

export function createBot(token: string, bridge: BridgeService): Bot {
  const bot = new Bot(token, {
    client: {
      fetch: telegramFetch as typeof fetch,
    },
  });
  const shellService = new RemoteShellService(config.commandTimeoutMs);
  const messageBatcher = new TelegramMessageBatcher(
    config.telegramMessageBatchMs,
    async (ctx, botId, chatId, text) => {
      await runWithPendingAnimation(ctx, async () => {
        const responses = await bridge.routeMessage(botId, chatId, text);
        return {
          chunks: flattenChunks(bridge.formatResponses(responses), 3900),
        };
      });
    },
  );
  const getBotId = (): string => bot.botInfo?.username ?? String(bot.botInfo?.id ?? token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "Pair this Telegram chat 1:1 with a Codex or Claude session.",
        HELP_TEXT,
      ].join("\n\n"),
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("session", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(botId, chatId);
    await ctx.reply(bridge.formatCurrentSession(mapping));
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
    await ctx.reply(bridge.formatSessionList(sessions, mapping?.session.sessionId));
  };

  bot.command("sessions", async (ctx) => {
    await replySessionList(ctx);
  });

  bot.command("list", async (ctx) => {
    await replySessionList(ctx);
  });

  bot.command("new", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { rest } = parseCommand(ctx.message?.text, 0);
    const mapping = await bridge.createSession(botId, chatId, rest);
    await ctx.reply(`Created and bound a new session.\n\n${bridge.formatCurrentSession(mapping)}`);
  });

  bot.command("switch", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 1);
    const sessionId = args[0];

    if (!sessionId) {
      await ctx.reply("Usage: `/switch <session>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.switchSession(botId, chatId, sessionId);
    await ctx.reply(`Switched this chat to session ${sessionId}.\n\n${bridge.formatCurrentSession(mapping)}`);
  });

  bot.command("batch", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 1);
    const action = args[0]?.toLowerCase();

    if (!action || !["start", "send", "done", "cancel", "status"].includes(action)) {
      await ctx.reply("Usage: `/batch start`, `/batch send`, `/batch cancel`, or `/batch status`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (action === "start") {
      messageBatcher.startManual(botId, chatId);
      await ctx.reply("Batch collection started. Send the log fragments, then run `/batch send`.", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (action === "send" || action === "done") {
      const result = await messageBatcher.sendManual(ctx, botId, chatId);
      if (!result.found) {
        await ctx.reply("No active batch. Run `/batch start` first.", { parse_mode: "Markdown" });
        return;
      }
      if (result.count === 0) {
        await ctx.reply("Batch was empty.");
      }
      return;
    }

    if (action === "cancel") {
      const result = messageBatcher.cancelManual(botId, chatId);
      await ctx.reply(result.found ? `Canceled batch with ${result.count} collected message(s).` : "No active batch.");
      return;
    }

    const result = messageBatcher.manualStatus(botId, chatId);
    await ctx.reply(result.found ? `Batch collection is active with ${result.count} message(s).` : "No active batch.");
  });

  bot.command("startpair", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args, rest } = parseCommand(ctx.message?.text, 1);
    const target = args[0]?.toLowerCase();

    if (!target || !["codex", "claude", "both"].includes(target)) {
      await ctx.reply("Usage: `/startpair codex [path]`, `/startpair claude [path]`, `/startpair both [path]`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (target === "both") {
      await bridge.startPair(botId, chatId, "codex", rest);
      const mapping = await bridge.startPair(botId, chatId, "claude", rest);
      await ctx.reply(`Started fresh Codex and Claude pairings.\n\n${bridge.formatStatus(mapping)}`);
      return;
    }

    const mapping = await bridge.startPair(botId, chatId, target as Provider, rest);
    await ctx.reply(`Started a fresh ${target} pairing.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("attach", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args, rest } = parseCommand(ctx.message?.text, 2);
    const provider = args[0]?.toLowerCase();
    const sessionId = args[1];

    if (!provider || !["codex", "claude"].includes(provider) || !sessionId) {
      await ctx.reply("Usage: `/attach codex <thread_id> [path]`, `/attach claude <session_id> [path]`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.attachPair(botId, chatId, provider as Provider, sessionId, rest);
    await ctx.reply(`Attached this chat to existing ${provider} session ${sessionId}.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("status", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(botId, chatId);
    await ctx.reply(bridge.formatStatus(mapping));
  });

  bot.command("sandbox", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 2);
    const provider = args[0]?.toLowerCase();
    const sandboxMode = args[1]?.toLowerCase();

    if (provider !== "codex" || !sandboxMode || !isCodexSandboxMode(sandboxMode)) {
      await ctx.reply("Usage: `/sandbox codex <read-only|workspace-write|danger-full-access>`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.setCodexSandboxMode(botId, chatId, sandboxMode);
    await ctx.reply(`Set Codex sandbox to ${sandboxMode}.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("mode", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 1);
    const mode = args[0]?.toLowerCase();

    if (!mode || !["codex", "claude", "compare"].includes(mode)) {
      await ctx.reply("Usage: `/mode codex`, `/mode claude`, `/mode compare`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.setMode(botId, chatId, mode as BridgeMode);
    await ctx.reply(`Switched mode to ${mapping.session.mode}.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("reset", async (ctx) => {
    const botId = getBotId();
    const chatId = String(ctx.chat.id);
    await bridge.reset(botId, chatId);
    await ctx.reply("Cleared all pairings for this chat.");
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const botId = getBotId();
    const chatId = String(ctx.chat.id);

    if (isRemoteShellMessage(text)) {
      const shellRequest = parseRemoteShellRequest(text);
      if (!shellRequest) {
        await ctx.reply("Usage: `/! <command>`, `/!cmd <command>`, or `/!bash <command>`", {
          parse_mode: "Markdown",
        });
        return;
      }

      const chatSession = await ensureRemoteShellAccess(ctx, bridge, botId, chatId);
      await bridge.logSystem(botId, chatId, `Remote shell request (${shellRequest.kind}): ${shellRequest.command}`);

      await runWithPendingAnimation(ctx, async () => {
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

    messageBatcher.enqueue(ctx, botId, chatId, text);
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
    void ctx.reply(error.error instanceof Error ? error.error.message : "An unexpected error occurred.");
  });

  return bot;
}

type PendingTelegramBatch = {
  ctx: Context;
  botId: string;
  chatId: string;
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
};

type ManualTelegramBatch = {
  messages: string[];
};

class TelegramMessageBatcher {
  private readonly pending = new Map<string, PendingTelegramBatch>();
  private readonly manual = new Map<string, ManualTelegramBatch>();

  constructor(
    private readonly delayMs: number,
    private readonly onBatch: (ctx: Context, botId: string, chatId: string, text: string) => Promise<void>,
  ) {}

  enqueue(ctx: Context, botId: string, chatId: string, text: string): void {
    const key = this.key(botId, chatId);
    const manualBatch = this.manual.get(key);
    if (manualBatch) {
      manualBatch.messages.push(text);
      return;
    }

    if (this.delayMs === 0) {
      void this.run(ctx, botId, chatId, text);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.ctx = ctx;
      existing.messages.push(text);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        void this.flush(key);
      }, this.delayMs);
      return;
    }

    this.pending.set(key, {
      ctx,
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

  async sendManual(ctx: Context, botId: string, chatId: string): Promise<{ found: boolean; count: number }> {
    const key = this.key(botId, chatId);
    const batch = this.manual.get(key);
    if (!batch) {
      return { found: false, count: 0 };
    }

    this.manual.delete(key);
    if (batch.messages.length === 0) {
      return { found: true, count: 0 };
    }

    await this.run(ctx, botId, chatId, batch.messages.join("\n"));
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

    await this.run(batch.ctx, batch.botId, batch.chatId, batch.messages.join("\n"));
  }

  private async run(ctx: Context, botId: string, chatId: string, text: string): Promise<void> {
    try {
      await this.onBatch(ctx, botId, chatId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      await ctx.reply(message).catch(() => undefined);
    }
  }

  private key(botId: string, chatId: string): string {
    return `${botId}:${chatId}`;
  }
}

async function runWithPendingAnimation(
  ctx: Context,
  task: () => Promise<{ chunks: string[]; parseMode?: "HTML" | "MarkdownV2" }>,
): Promise<void> {
  if (!ctx.chat) {
    throw new Error("Telegram chat context is missing.");
  }

  const pending = await ctx.reply("Working.");
  const pendingFrames = ["Working.", "Working..", "Working...", "Working...."];
  let pendingIndex = 0;
  const pendingLoop = setInterval(() => {
    pendingIndex = (pendingIndex + 1) % pendingFrames.length;
    void ctx.api.editMessageText(ctx.chat!.id, pending.message_id, pendingFrames[pendingIndex]).catch(() => undefined);
  }, 3000);

  try {
    const result = await task();
    const chunks = result.chunks;
    const extra = result.parseMode ? { parse_mode: result.parseMode } : undefined;

    if (chunks.length === 0) {
      await ctx.api.editMessageText(ctx.chat.id, pending.message_id, "응답이 비어 있습니다.");
      return;
    }

    await ctx.api.deleteMessage(ctx.chat.id, pending.message_id).catch(() => undefined);
    for (const chunk of chunks) {
      await ctx.reply(chunk, extra);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    await ctx.api.editMessageText(ctx.chat.id, pending.message_id, message).catch(async () => {
      await ctx.reply(message);
    });
  } finally {
    clearInterval(pendingLoop);
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
