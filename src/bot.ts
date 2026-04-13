import { Bot, GrammyError, HttpError } from "grammy";
import { BridgeService } from "./services/bridge-service.js";
import type { BridgeMode, Provider } from "./types.js";

const HELP_TEXT = [
  "명령어",
  "/startpair codex",
  "/startpair claude",
  "/startpair both",
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
        "텔레그램 채팅방을 Codex 또는 Claude 세션과 1:1로 연결하는 브리지입니다.",
        HELP_TEXT,
      ].join("\n\n"),
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("startpair", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = getArgs(ctx.message?.text);
    const target = args[0]?.toLowerCase();

    if (!target || !["codex", "claude", "both"].includes(target)) {
      await ctx.reply("사용법: `/startpair codex`, `/startpair claude`, `/startpair both`", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (target === "both") {
      await bridge.startPair(chatId, "codex");
      const mapping = await bridge.startPair(chatId, "claude");
      await ctx.reply(`세션 2개를 연결했습니다.\n\n${bridge.formatStatus(mapping)}`);
      return;
    }

    const mapping = await bridge.startPair(chatId, target as Provider);
    await ctx.reply(`${target} 세션을 연결했습니다.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("status", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const mapping = await bridge.status(chatId);
    await ctx.reply(bridge.formatStatus(mapping), { parse_mode: "Markdown" });
  });

  bot.command("mode", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = getArgs(ctx.message?.text);
    const mode = args[0]?.toLowerCase();

    if (!mode || !["codex", "claude", "compare"].includes(mode)) {
      await ctx.reply("사용법: `/mode codex`, `/mode claude`, `/mode compare`", {
        parse_mode: "Markdown",
      });
      return;
    }

    const mapping = await bridge.setMode(chatId, mode as BridgeMode);
    await ctx.reply(`모드를 ${mapping.mode}로 바꿨습니다.\n\n${bridge.formatStatus(mapping)}`);
  });

  bot.command("reset", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await bridge.reset(chatId);
    await ctx.reply("이 채팅방의 세션 매핑을 초기화했습니다.");
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
    void ctx.reply(error.error instanceof Error ? error.error.message : "알 수 없는 오류가 발생했습니다.");
  });

  return bot;
}

function getArgs(text: string | undefined): string[] {
  return text?.trim().split(/\s+/).slice(1) ?? [];
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
