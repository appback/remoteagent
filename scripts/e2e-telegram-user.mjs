#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const dryRun = process.argv.includes("--dry-run");
const apiId = Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
const apiHash = process.env.TELEGRAM_API_HASH?.trim() ?? "";
const testBot = normalizeBotUsername(process.env.TELEGRAM_TEST_BOT ?? "");
const sessionFile = path.resolve(process.env.TELEGRAM_USER_SESSION_FILE ?? ".local/telegram-user.session");
const timeoutMs = Number.parseInt(process.env.TELEGRAM_E2E_TIMEOUT_MS ?? "60000", 10);

const testMessages = [
  "/start codex",
  "/task new 같은 값을 봐야하는데 로직문제네? 확인해줘\n이미 수정되어 있을 수 있어.\n나한테 수정했다고 보고했었거든",
  "/task",
];

validateConfig();

if (dryRun) {
  console.log(JSON.stringify({
    ok: true,
    mode: "dry-run",
    apiId,
    apiHashSet: Boolean(apiHash),
    testBot,
    sessionFile,
    timeoutMs,
    testMessages: testMessages.length,
  }, null, 2));
  process.exit(0);
}

await fs.mkdir(path.dirname(sessionFile), { recursive: true });
const savedSession = await fs.readFile(sessionFile, "utf8").catch(() => "");
const stringSession = new StringSession(savedSession.trim());
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

console.log(`Connecting Telegram user client for ${testBot}...`);
await client.start({
  phoneNumber: async () => process.env.TELEGRAM_PHONE_NUMBER || await input.text("Telegram phone number: "),
  password: async () => process.env.TELEGRAM_2FA_PASSWORD || await input.password("Telegram 2FA password: "),
  phoneCode: async () => await input.text("Telegram login code: "),
  onError: (error) => console.error("Telegram login error:", error),
});

const sessionString = client.session.save();
await fs.writeFile(sessionFile, sessionString, "utf8");
await fs.chmod(sessionFile, 0o600).catch(() => undefined);
console.log(`Telegram user session saved: ${sessionFile}`);

const entity = await client.getEntity(testBot);
const before = await getLatestIncomingBotMessage(client, entity);
let lastSeenId = before?.id ?? 0;
const results = [];

for (const message of testMessages) {
  console.log(`-> ${firstLine(message)}`);
  await client.sendMessage(entity, { message });
  const reply = await waitForIncomingBotMessage(client, entity, lastSeenId, timeoutMs);
  lastSeenId = Math.max(lastSeenId, reply.id);
  console.log(`<-${reply.id} ${firstLine(reply.message)}`);
  results.push({ sent: message, replyId: reply.id, reply: reply.message });
}

assertReply(results, 1, /새 작업으로 접수|Started a fresh|No installed coding mode|No paired session/i, "task new acknowledgement or setup response");
assertReply(results, 2, /Task status|TODO|No paired session|No installed coding mode/i, "task status response");

console.log(JSON.stringify({
  ok: true,
  bot: testBot,
  sessionFile,
  replies: results.map((result) => ({
    replyId: result.replyId,
    firstLine: firstLine(result.reply),
  })),
}, null, 2));

await client.disconnect();

function validateConfig() {
  const missing = [];
  if (!Number.isInteger(apiId) || apiId <= 0) {
    missing.push("TELEGRAM_API_ID");
  }
  if (!apiHash) {
    missing.push("TELEGRAM_API_HASH");
  }
  if (!testBot) {
    missing.push("TELEGRAM_TEST_BOT");
  }
  if (missing.length > 0) {
    throw new Error([
      `Missing required env: ${missing.join(", ")}`,
      "",
      "Example:",
      "TELEGRAM_API_ID=123456 \\",
      "TELEGRAM_API_HASH=abcdef... \\",
      "TELEGRAM_TEST_BOT=@your_bot \\",
      "npm run e2e:telegram-user",
    ].join("\n"));
  }
}

function normalizeBotUsername(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

async function getLatestIncomingBotMessage(client, entity) {
  const messages = await client.getMessages(entity, { limit: 10 });
  return [...messages]
    .filter((message) => !message.out && typeof message.message === "string" && message.message.length > 0)
    .sort((left, right) => Number(right.id) - Number(left.id))[0];
}

async function waitForIncomingBotMessage(client, entity, afterId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const messages = await client.getMessages(entity, { limit: 10 });
    const match = [...messages]
      .filter((message) => !message.out && Number(message.id) > afterId && typeof message.message === "string" && message.message.length > 0)
      .sort((left, right) => Number(left.id) - Number(right.id))[0];
    if (match) {
      return match;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for bot reply after message id ${afterId}`);
}

function assertReply(results, index, pattern, label) {
  const reply = results[index]?.reply ?? "";
  if (!pattern.test(reply)) {
    throw new Error(`Expected ${label}, got: ${reply.slice(0, 500)}`);
  }
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/, 1)[0].slice(0, 160);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
