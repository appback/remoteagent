#!/usr/bin/env node

import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { FileStore } from "./store/file-store.js";
import type { SessionRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_TELEGRAM_TEXT = 3900;

async function main(): Promise<void> {
  const { sessionSelector, message } = await parseCli(process.argv.slice(2));
  const store = new FileStore(config.dataDir, config.defaultMode);
  await store.init();

  const sessions = await store.listSessions();
  const session = resolveSession(sessions, sessionSelector);
  if (!session) {
    throw new Error(`Session was not found: ${sessionSelector}`);
  }

  const reportTarget = session.reportTarget;
  if (!reportTarget || reportTarget.transport !== "telegram") {
    throw new Error(
      `Session ${session.publicId} does not have a Telegram report target. Configure it first with /reportbot use current in the target chat.`,
    );
  }

  const token = resolveBotToken(reportTarget.botId, reportTarget.username);
  if (!token) {
    throw new Error(
      `Configured report bot '${reportTarget.username ?? reportTarget.botId}' is no longer available on this machine.`,
    );
  }

  const chunks = chunkText(message, MAX_TELEGRAM_TEXT);
  for (const chunk of chunks) {
    await sendTelegramMessage(token, Number(reportTarget.chatId), chunk);
  }

  process.stdout.write(
    `Delivered ${chunks.length} Telegram report message(s) to ${reportTarget.username ? `@${reportTarget.username}` : reportTarget.botId} for session ${session.publicId}.\n`,
  );
}

async function parseCli(argv: string[]): Promise<{ sessionSelector: string; message: string }> {
  let sessionSelector = "";
  const messageParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--session") {
      sessionSelector = argv[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    messageParts.push(arg);
  }

  if (!sessionSelector) {
    sessionSelector = process.env.REMOTEAGENT_PUBLIC_SESSION_ID?.trim()
      || process.env.REMOTEAGENT_SESSION_ID?.trim()
      || "";
  }

  if (!sessionSelector) {
    throw new Error("Usage: report-telegram --session <session> <message>");
  }

  let message = messageParts.join(" ").trim();
  if (!message && !process.stdin.isTTY) {
    message = (await readStdin()).trim();
  }

  if (!message) {
    throw new Error("Report message is empty.");
  }

  return { sessionSelector, message };
}

function resolveSession(sessions: SessionRecord[], selector: string): SessionRecord | undefined {
  const trimmed = selector.trim();
  if (!trimmed) {
    return undefined;
  }

  const upper = trimmed.toUpperCase();
  return sessions.find((session) =>
    session.sessionId === trimmed
    || session.publicId.toUpperCase() === upper,
  );
}

function resolveBotToken(botId: string, username?: string): string | undefined {
  const desiredId = botId.trim();
  const desiredUsername = username?.trim().toLowerCase();

  return config.telegramBotTokens.find((token, index) => {
    const tokenId = token.split(":", 1)[0]?.trim() ?? "";
    const configuredUsername = config.telegramBotUsernames[index]?.trim().toLowerCase();
    return tokenId === desiredId
      || configuredUsername === desiredId.toLowerCase()
      || (desiredUsername ? configuredUsername === desiredUsername : false);
  });
}

function chunkText(text: string, maxLength: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxLength) {
    let sliceAt = remaining.lastIndexOf("\n", maxLength);
    if (sliceAt < Math.floor(maxLength / 2)) {
      sliceAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (sliceAt < Math.floor(maxLength / 2)) {
      sliceAt = maxLength;
    }

    chunks.push(remaining.slice(0, sliceAt).trimEnd());
    remaining = remaining.slice(sliceAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {
    parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
  });

  const { stdout, stderr } = await execFileAsync("curl", [
    "-sS",
    "--max-time",
    "20",
    "-H",
    "Content-Type: application/json",
    "-d",
    payload,
    url,
  ]);

  if (stderr?.trim()) {
    console.error("curl stderr for report sendMessage:", stderr.trim());
  }

  const parsed = JSON.parse(stdout) as { ok?: boolean; description?: string };
  if (!parsed.ok) {
    throw new Error(parsed.description || "Telegram sendMessage failed.");
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
