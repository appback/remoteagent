#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "remoteagent-telegram-inject-"));
const dataDir = path.join(tmp, "data");
const workspace = path.join(tmp, "workspace");
const workspaceRoot = path.join(tmp, "workspaces");
const binDir = path.join(tmp, "bin");
const telegramCalls = path.join(tmp, "telegram-calls.jsonl");

await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.mkdir(binDir, { recursive: true });

await fs.writeFile(path.join(binDir, "curl"), `#!/usr/bin/env bash
set -euo pipefail
method="unknown"
text=""
chat_id=""
for arg in "$@"; do
  case "$arg" in
    https://api.telegram.org/bot*/sendMessage) method="sendMessage" ;;
    https://api.telegram.org/bot*/editMessageText) method="editMessageText" ;;
    https://api.telegram.org/bot*/deleteMessage) method="deleteMessage" ;;
    https://api.telegram.org/bot*/sendDocument) method="sendDocument" ;;
    chat_id=*) chat_id="\${arg#chat_id=}" ;;
    text=*) text="\${arg#text=}" ;;
  esac
done
text_b64="$(printf '%s' "$text" | base64 -w 0)"
printf '%s\\t%s\\t%s\\n' "$method" "$chat_id" "$text_b64" >> ${JSON.stringify(telegramCalls)}
case "$method" in
  sendMessage|editMessageText)
    printf '{"ok":true,"result":{"message_id":1001}}'
    ;;
  deleteMessage)
    printf '{"ok":true,"result":true}'
    ;;
  sendDocument)
    printf '{"ok":true,"result":{"message_id":1002,"document":{"file_id":"fake"}}}'
    ;;
  *)
    printf '{"ok":true,"result":true}'
    ;;
esac
`, "utf8");
await fs.chmod(path.join(binDir, "curl"), 0o755);

process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
process.env.DATA_DIR = dataDir;
process.env.DEFAULT_WORKSPACE = workspace;
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.TELEGRAM_BOT_TOKEN = "000000:test-token";
process.env.TELEGRAM_OWNER_ID = "111";
process.env.TELEGRAM_MESSAGE_BATCH_MS = "600000";
process.env.TELEGRAM_AUTO_PROGRESS_MAX_TURNS = "1";
process.env.TELEGRAM_EMPTY_RESPONSE_RETRIES = "0";
process.env.TELEGRAM_RETRYABLE_ERROR_RETRIES = "0";
process.env.LOCAL_UI_ENABLED = "false";

const [{ createBot }, { BridgeService }, { BotManagementService }, { FileStore }, { AgentMemoryService }] = await Promise.all([
  import(path.join(root, "dist", "bot.js")),
  import(path.join(root, "dist", "services", "bridge-service.js")),
  import(path.join(root, "dist", "services", "bot-management-service.js")),
  import(path.join(root, "dist", "store", "file-store.js")),
  import(path.join(root, "dist", "services", "agent-memory-service.js")),
]);

const providerCalls = [];
const provider = {
  async send(request) {
    providerCalls.push(request);
    return {
      provider: "codex",
      sessionId: request.sessionId || "mock-thread",
      publicSessionId: request.publicSessionId,
      cwd: request.cwd,
      output: "REPORT:result\\nmock provider completed",
    };
  },
};

const store = new FileStore(dataDir, "codex");
await store.init();
const bridge = new BridgeService(
  store,
  { codex: provider },
  workspace,
  workspaceRoot,
  (name) => name === "codex",
  "codex",
  "workspace-write",
);
const botManagement = new BotManagementService(dataDir, undefined, undefined);
const bot = createBot("000000:test-token", bridge, botManagement, {
  id: 999001,
  is_bot: true,
  first_name: "RemoteAgent Test",
  username: "remoteagent_test_bot",
});

const injectedBot = bot;
let updateId = 1000;
let messageId = 2000;
const now = () => Math.floor(Date.now() / 1000);

function commandEntity(text) {
  const first = text.split(/\s+/, 1)[0] ?? text;
  return [{ type: "bot_command", offset: 0, length: first.length }];
}

function update(text) {
  return {
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: now(),
      chat: { id: 111222333, type: "private", first_name: "Tester", username: "tester" },
      from: { id: 111, is_bot: false, first_name: "Tester", username: "tester" },
      text,
      entities: text.startsWith("/") ? commandEntity(text) : undefined,
    },
  };
}

async function send(text) {
  await injectedBot.handleUpdates([update(text)]);
}

await send("/start codex");
await send("/task new 같은 값을 봐야하는데 로직문제네? 확인해줘\\n이미 수정되어 있을 수 있어.\\n나한테 수정했다고 보고했었거든");
await send("/task");

const state = JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
const sessions = Object.values(state.sessions);
if (sessions.length !== 1) {
  throw new Error(`Expected one session, got ${sessions.length}`);
}
const session = sessions[0];
const todo = JSON.parse(await fs.readFile(path.join(dataDir, "managed", "sessions", session.publicId, "todo.json"), "utf8"));
const active = todo.items.filter((item) => item.status === "in_progress" || item.status === "pending");
if (todo.items.length !== 1) {
  throw new Error(`Expected one TODO item, got ${todo.items.length}`);
}
if (active.length !== 1) {
  throw new Error(`Expected one active TODO item, got ${active.length}`);
}
if (/Auto-cleared non-actionable/.test(JSON.stringify(todo))) {
  throw new Error("TODO was auto-cleared as non-actionable");
}
if (providerCalls.length !== 0) {
  throw new Error(`Provider should not run before batch flush, got ${providerCalls.length} calls`);
}

const memory = new AgentMemoryService(dataDir);
const developmentSession = {
  ...session,
  sessionId: "selftest-development-session",
  publicId: "SDEV",
  workspace: path.join(tmp, "dev-workspace"),
};
await memory.recordInstruction(developmentSession, "그럼 기프티쇼 개발 진행해");
const developmentTodo = JSON.parse(await fs.readFile(path.join(dataDir, "managed", "sessions", "SDEV", "todo.json"), "utf8"));
const developmentActive = developmentTodo.items.filter((item) => item.status === "in_progress" || item.status === "pending");
if (developmentActive.length !== 1 || !/기프티쇼|개발|진행/.test(developmentActive[0].text)) {
  throw new Error(`Development instruction did not create an active TODO: ${JSON.stringify(developmentTodo, null, 2)}`);
}

const legacySession = {
  ...session,
  sessionId: "selftest-legacy-session",
  publicId: "SLEG",
  workspace: path.join(tmp, "legacy-workspace"),
};
const legacyDir = path.join(dataDir, "managed", "sessions", "SLEG");
await fs.mkdir(legacyDir, { recursive: true });
await fs.writeFile(path.join(legacyDir, "current.md"), [
  "# Current Task",
  "",
  "session: SLEG",
  "updatedAt: 2026-06-09T00:00:00.000Z",
  "",
  "## Instruction",
  "그럼 기프티쇼 개발 진행해",
  "",
  "## Immediate Rule",
  "Manage work by the TODO list.",
  "",
].join("\n"), "utf8");
await fs.writeFile(path.join(legacyDir, "todo.json"), JSON.stringify({ createdAt: "", updatedAt: "", items: [] }, null, 2), "utf8");
await memory.recordInstruction(legacySession, "진행해");
const recoveredTodo = JSON.parse(await fs.readFile(path.join(legacyDir, "todo.json"), "utf8"));
const recoveredActive = recoveredTodo.items.filter((item) => item.status === "in_progress" || item.status === "pending");
if (recoveredActive.length !== 1 || !/기프티쇼|개발/.test(recoveredActive[0].text)) {
  throw new Error(`Continuation did not recover TODO from current note: ${JSON.stringify(recoveredTodo, null, 2)}`);
}

const calls = (await fs.readFile(telegramCalls, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [method, chatId, textB64 = ""] = line.split("\t");
    return {
      method,
      chat_id: chatId,
      text: Buffer.from(textB64, "base64").toString("utf8"),
    };
  });
if (!calls.some((call) => call.method === "sendMessage" && /새 작업으로 접수/.test(call.text))) {
  throw new Error(`Did not see immediate /task new acknowledgement. Calls: ${JSON.stringify(calls, null, 2)}`);
}
if (!calls.some((call) => call.method === "sendMessage" && /Task status for S001/.test(call.text))) {
  throw new Error(`Did not see task status reply. Calls: ${JSON.stringify(calls, null, 2)}`);
}

console.log(JSON.stringify({
  ok: true,
  dataDir,
  session: session.publicId,
  todoItems: todo.items.length,
  activeTodoItems: active.length,
  developmentTodoItems: developmentActive.length,
  recoveredTodoItems: recoveredActive.length,
  providerCalls: providerCalls.length,
  telegramSendMessages: calls.filter((call) => call.method === "sendMessage").length,
}, null, 2));

process.exit(0);
