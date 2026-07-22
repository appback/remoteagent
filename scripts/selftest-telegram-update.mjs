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
let providerMode = "success";
let untaggedIntentCalls = 0;
let missingEvidenceCalls = 0;
const provider = {
  async send(request) {
    providerCalls.push(request);
    if (providerMode === "timeout") {
      throw new Error("Codex timed out after 600s without returning a final reply.");
    }
    if (providerMode === "untagged-intent") {
      untaggedIntentCalls += 1;
      return {
        provider: "codex",
        sessionId: request.sessionId || "mock-thread",
        publicSessionId: request.publicSessionId,
        cwd: request.cwd,
        output: untaggedIntentCalls === 1
          ? "계속 진행해서 확인하겠습니다."
          : "REPORT:result\nuntagged intent recovered",
      };
    }
    if (providerMode === "missing-evidence") {
      missingEvidenceCalls += 1;
      return {
        provider: "codex",
        sessionId: request.sessionId || "mock-thread",
        publicSessionId: request.publicSessionId,
        cwd: request.cwd,
        output: missingEvidenceCalls === 1
          ? "REPORT:result\n수정 완료했습니다."
          : "REPORT:result\n수정 완료했습니다.\n\n근거:\n- 변경 파일: `src/example.ts`\n- 검증: `npm run check` 통과",
      };
    }
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
await send("/option retry 6");
await send("/option timeout 600");
await send("/option intent 4");
await send("같은 값을 봐야하는데 로직문제네? 확인해줘\\n이미 수정되어 있을 수 있어.\\n나한테 수정했다고 보고했었거든");
await send("/state");

const state = JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
const sessions = Object.values(state.sessions);
if (sessions.length !== 1) {
  throw new Error(`Expected one session, got ${sessions.length}`);
}
const session = sessions[0];
if (providerCalls.length !== 0) {
  throw new Error(`Provider should not run before batch flush, got ${providerCalls.length} calls`);
}
const envText = await fs.readFile(path.join(dataDir, ".env"), "utf8");
if (!/^TELEGRAM_AUTO_PROGRESS_MAX_TURNS=6$/m.test(envText)) {
  throw new Error(`Option command did not persist retry limit to .env: ${envText}`);
}
if (!/^COMMAND_TIMEOUT_MS=600000$/m.test(envText)) {
  throw new Error(`Option command did not persist command timeout to .env: ${envText}`);
}
if (!/^TELEGRAM_UNTAGGED_INTENT_RETRIES=4$/m.test(envText)) {
  throw new Error(`Option command did not persist untagged intent retry limit to .env: ${envText}`);
}

const memory = new AgentMemoryService(dataDir);
const developmentSession = {
  ...session,
  sessionId: "selftest-development-session",
  publicId: "SDEV",
  workspace: path.join(tmp, "dev-workspace"),
};
await memory.recordInstruction(developmentSession, "그럼 기프티쇼 개발 진행해");
const developmentCurrent = await fs.readFile(path.join(dataDir, "managed", "sessions", "SDEV", "current.md"), "utf8");
if (!/기프티쇼 개발 진행해/.test(developmentCurrent) || /Manage work by the TODO list/.test(developmentCurrent)) {
  throw new Error(`Development instruction was not stored as session state: ${developmentCurrent}`);
}
const developmentContext = await memory.formatProviderContext(developmentSession);
if (/Task TODO: none|context only|Manage work by the TODO list/.test(developmentContext)) {
  throw new Error(`Provider context still contains TODO gate language: ${developmentContext}`);
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
  "# Session State",
  "",
  "session: SLEG",
  "updatedAt: 2026-06-09T00:00:00.000Z",
  "",
  "## Latest User Instruction",
  "그럼 기프티쇼 개발 진행해",
  "",
  "## Harness Rule",
  "RemoteAgent records this as session state.",
  "",
].join("\n"), "utf8");
await fs.writeFile(path.join(legacyDir, "todo.json"), JSON.stringify({ createdAt: "", updatedAt: "", items: [] }, null, 2), "utf8");
await memory.recordInstruction(legacySession, "진행해");
const recoveredTodo = JSON.parse(await fs.readFile(path.join(legacyDir, "todo.json"), "utf8"));
const recoveredActive = recoveredTodo.items.filter((item) => item.status === "in_progress" || item.status === "pending");
if (recoveredActive.length !== 0) {
  throw new Error(`Continuation unexpectedly created TODO gate items: ${JSON.stringify(recoveredTodo, null, 2)}`);
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
if (!calls.some((call) => call.method === "sendMessage" && /Session state for S001/.test(call.text))) {
  throw new Error(`Did not see state status reply. Calls: ${JSON.stringify(calls, null, 2)}`);
}
if (!calls.some((call) => call.method === "sendMessage" && /Set automatic continuation retry limit to 6/.test(call.text))) {
  throw new Error(`Did not see option retry acknowledgement. Calls: ${JSON.stringify(calls, null, 2)}`);
}
if (!calls.some((call) => call.method === "sendMessage" && /Set provider execution timeout to 600s/.test(call.text))) {
  throw new Error(`Did not see option timeout acknowledgement. Calls: ${JSON.stringify(calls, null, 2)}`);
}
if (!calls.some((call) => call.method === "sendMessage" && /Set untagged intent retry limit to 4/.test(call.text))) {
  throw new Error(`Did not see option intent acknowledgement. Calls: ${JSON.stringify(calls, null, 2)}`);
}
if (calls.some((call) => /미완료 TODO|\/task|새 작업으로 접수/.test(call.text))) {
  throw new Error(`Task gate language leaked to Telegram replies. Calls: ${JSON.stringify(calls, null, 2)}`);
}

providerMode = "timeout";
await send("/batch start");
await send("timeout regression test");
await send("/batch send");

const timeoutCalls = (await fs.readFile(telegramCalls, "utf8"))
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
if (!timeoutCalls.some((call) => /Codex 실행이 600초 안에 최종 응답을 반환하지 않아 중단했습니다/.test(call.text))) {
  throw new Error(`Did not see provider timeout final message. Calls: ${JSON.stringify(timeoutCalls, null, 2)}`);
}
if (timeoutCalls.some((call) => /응답이 지연되어 .*다시 시도합니다/.test(call.text))) {
  throw new Error(`Provider timeout should not be automatically retried. Calls: ${JSON.stringify(timeoutCalls, null, 2)}`);
}

providerMode = "untagged-intent";
await send("/batch start");
await send("untagged intent regression test");
await send("/batch send");

const untaggedCalls = (await fs.readFile(telegramCalls, "utf8"))
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
if (untaggedIntentCalls !== 2) {
  throw new Error(`Expected untagged intent response to be retried once, got ${untaggedIntentCalls}`);
}
if (!untaggedCalls.some((call) => /untagged intent recovered/.test(call.text))) {
  throw new Error(`Did not see recovered result after untagged intent retry. Calls: ${JSON.stringify(untaggedCalls, null, 2)}`);
}
if (untaggedCalls.some((call) => call.method === "sendMessage" && /^계속 진행해서 확인하겠습니다\.$/.test(call.text.trim()))) {
  throw new Error(`Untagged intent-only response leaked as final Telegram message. Calls: ${JSON.stringify(untaggedCalls, null, 2)}`);
}

providerMode = "missing-evidence";
await send("/batch start");
await send("missing evidence regression test");
await send("/batch send");

const evidenceCalls = (await fs.readFile(telegramCalls, "utf8"))
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
if (missingEvidenceCalls !== 2) {
  throw new Error(`Expected missing evidence result to be retried once, got ${missingEvidenceCalls}`);
}
if (!evidenceCalls.some((call) =>
  /변경 파일: (?:`|<code>)src\/example\.ts(?:`|<\/code>)/.test(call.text)
  && /(?:`|<code>)npm run check(?:`|<\/code>) 통과/.test(call.text)
)) {
  throw new Error(`Did not see recovered result with concrete evidence. Calls: ${JSON.stringify(evidenceCalls, null, 2)}`);
}
if (evidenceCalls.some((call) => call.method === "sendMessage" && /^수정 완료했습니다\.$/.test(call.text.trim()))) {
  throw new Error(`Evidence-free completion leaked as final Telegram message. Calls: ${JSON.stringify(evidenceCalls, null, 2)}`);
}

console.log(JSON.stringify({
  ok: true,
  dataDir,
  session: session.publicId,
  developmentState: /기프티쇼 개발 진행해/.test(developmentCurrent),
  recoveredTodoItems: recoveredActive.length,
  retryOption: 6,
  timeoutOptionMs: 600000,
  intentRetryOption: 4,
  providerCalls: providerCalls.length,
  untaggedIntentCalls,
  missingEvidenceCalls,
  timeoutFinalMessage: true,
  telegramSendMessages: evidenceCalls.filter((call) => call.method === "sendMessage").length,
}, null, 2));

process.exit(0);
