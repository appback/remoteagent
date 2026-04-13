import { Bot, GrammyError, HttpError } from "grammy";
import { BridgeService } from "./services/bridge-service.js";
import type { BridgeMode, Provider } from "./types.js";

const HELP_TEXT = [
  "Commands:",
  "/startpair codex [path]",
  "/startpair claude [path]",
  "/startpair both [path]",
  "/attach codex <thread_id> [path]",
  "/attach claude <session_id> [path]",
  "/status",
  "/mode codex",
  "/mode claude",
  "/mode compare",
  "/reset",
].join("\n");

export function createBot(token: string, bridge: BridgeService): Bot {
  const bot = new Bot(token);

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

  bot.command("startpair", async (ctx) => {
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
      await bridge.startPair(chatId, "codex", rest);
      const mapping = await bridge.startPair(chatId, "claude", rest);
      await ctx.reply(`Started fresh Codex and Claude pairings.\n\n${bridge.formatStatus(mapping)}`);
      return;
    }

    const mapping = await bridge.startPair(chatId, target as Provider, rest);
    await ctx.reply(`Started a fresh ${target} pairing.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("attach", async (ctx) => {
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

    const mapping = await bridge.attachPair(chatId, provider as Provider, sessionId, rest);
    await ctx.reply(`Attached this chat to existing ${provider} session \`${sessionId}\`.\n\n${bridge.formatStatus(mapping)}`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("status", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(chatId);
    await ctx.reply(bridge.formatStatus(mapping), { parse_mode: "Markdown" });
  });

  bot.command("mode", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const { args } = parseCommand(ctx.message?.text, 1);
    const mode = args[0]?.toLowerCase();

    if (!mode || !["codex", "claude", "compare"].includes(mode)) {
      await ctx.reply("Usage: `/mode codex`, `/mode claude`, `/mode compare`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.setMode(chatId, mode as BridgeMode);
    await ctx.reply(`Switched mode to ${mapping.mode}.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("reset", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await bridge.reset(chatId);
    await ctx.reply("Cleared all pairings for this chat.");
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      return;
    }

    await ctx.replyWithChatAction("typing");
    const responses = await bridge.routeMessage(String(ctx.chat.id), text);
    const blocks = bridge.formatResponses(responses);

    for (const block of blocks) {
      for (const chunk of chunkMessage(block, 3900)) {
        await ctx.reply(chunk);
      }
    }
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
