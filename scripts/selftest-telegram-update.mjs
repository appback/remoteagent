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
const capturedDocument = path.join(tmp, "captured-document.ra-secrets");
const rateLimitOnce = path.join(tmp, "telegram-rate-limit-once");

await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.mkdir(binDir, { recursive: true });

await fs.writeFile(path.join(binDir, "curl"), `#!/usr/bin/env bash
set -euo pipefail
method="unknown"
text=""
chat_id=""
reply_markup=""
document_path=""
for arg in "$@"; do
  case "$arg" in
    https://api.telegram.org/bot*/sendMessage) method="sendMessage" ;;
    https://api.telegram.org/bot*/sendChatAction) method="sendChatAction" ;;
    https://api.telegram.org/bot*/editMessageText) method="editMessageText" ;;
    https://api.telegram.org/bot*/deleteMessage) method="deleteMessage" ;;
    https://api.telegram.org/bot*/sendDocument) method="sendDocument" ;;
    https://api.telegram.org/bot*/answerCallbackQuery) method="answerCallbackQuery" ;;
    chat_id=*) chat_id="\${arg#chat_id=}" ;;
    text=*) text="\${arg#text=}" ;;
    reply_markup=*) reply_markup="\${arg#reply_markup=}" ;;
    document=@*) document_path="\${arg#document=@}" ;;
  esac
done
text_b64="$(printf '%s' "$text" | base64 -w 0)"
reply_markup_b64="$(printf '%s' "$reply_markup" | base64 -w 0)"
printf '%s\\t%s\\t%s\\t%s\\n' "$method" "$chat_id" "$text_b64" "$reply_markup_b64" >> ${JSON.stringify(telegramCalls)}
if [[ "$method" == "sendMessage" && -n "\${TELEGRAM_SELFTEST_RATE_LIMIT_FILE:-}" && -f "\${TELEGRAM_SELFTEST_RATE_LIMIT_FILE}" ]]; then
  rm -f "\${TELEGRAM_SELFTEST_RATE_LIMIT_FILE}"
  printf '{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 1","parameters":{"retry_after":1}}'
  exit 0
fi
case "$method" in
  sendMessage|editMessageText)
    printf '{"ok":true,"result":{"message_id":1001}}'
    ;;
  deleteMessage|answerCallbackQuery)
    printf '{"ok":true,"result":true}'
    ;;
  sendDocument)
    cp "$document_path" ${JSON.stringify(capturedDocument)}
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
process.env.TELEGRAM_SELFTEST_RATE_LIMIT_FILE = rateLimitOnce;

const [
  { createBot },
  { BridgeService },
  { BotManagementService },
  { FileStore },
  { AgentMemoryService },
  { importSecrets },
  { WorkspaceCleanupService },
  { buildFallbackBotInfo },
] = await Promise.all([
  import(path.join(root, "dist", "bot.js")),
  import(path.join(root, "dist", "services", "bridge-service.js")),
  import(path.join(root, "dist", "services", "bot-management-service.js")),
  import(path.join(root, "dist", "store", "file-store.js")),
  import(path.join(root, "dist", "services", "agent-memory-service.js")),
  import(path.join(root, "dist", "services", "secret-transfer-service.js")),
  import(path.join(root, "dist", "services", "workspace-cleanup-service.js")),
  import(path.join(root, "dist", "telegram-bot-identity.js")),
]);

const persistedBotIdentity = buildFallbackBotInfo(
  "8966593034:test-token",
  0,
  "@appbackadmin_bot",
);
if (persistedBotIdentity.username !== "appbackadmin_bot") {
  throw new Error(`Configured bot username was not preserved during getMe fallback: ${persistedBotIdentity.username}`);
}

const providerCalls = [];
let providerMode = "success";
let literalResponse = "";
let explicitResponses = [];
let untaggedIntentCalls = 0;
let missingEvidenceCalls = 0;
let streamingFinalProgressCalls = 0;
let usageLimitCalls = 0;
let queueHoldStartedResolve;
let queueHoldReleaseResolve;
let queueHoldStartedPromise = Promise.resolve();
let queueHoldReleasePromise = Promise.resolve();
const provider = {
  async send(request) {
    providerCalls.push(request);
    if (providerMode === "timeout") {
      throw new Error("Codex timed out after 600s without returning a final reply.");
    }
    if (providerMode === "usage-limit") {
      usageLimitCalls += 1;
      if (request.model !== "gpt-5.3-codex-spark") {
        throw new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 27th, 2099 3:52 AM.");
      }
      return {
        provider: "codex",
        sessionId: request.sessionId || "mock-thread",
        publicSessionId: request.publicSessionId,
        cwd: request.cwd,
        output: "REPORT:result\nusage fallback completed with evidence: `fallback-test.log`",
      };
    }
    if (providerMode === "literal-result") {
      return {provider: "codex", sessionId: request.sessionId || "mock-thread", cwd: request.cwd, output: literalResponse};
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
    if (providerMode === "explicit-status") {
      return {provider: "codex", sessionId: request.sessionId || "mock-thread", cwd: request.cwd, output: explicitResponses.shift() ?? "REPORT:result\nunexpected extra call"};
    }
    if (providerMode === "queue-hold" || providerMode === "stop-hold") {
      queueHoldStartedResolve?.();
      await queueHoldReleasePromise;
      return {
        provider: "codex",
        sessionId: request.sessionId || "mock-thread",
        publicSessionId: request.publicSessionId,
        cwd: request.cwd,
        output: providerMode === "stop-hold" ? "REPORT:progress\nstop regression progress" : "REPORT:result\nactive queue test completed",
      };
    }
    if (providerMode === "streaming-progress") {
      await request.onProgress?.("REPORT:progress\nstreamed phase one completed");
      await request.onProgress?.("REPORT:progress\nstreamed phase two completed");
      return {
        provider: "codex",
        sessionId: request.sessionId || "mock-thread",
        publicSessionId: request.publicSessionId,
        cwd: request.cwd,
        output: "REPORT:result\nstreamed provider completed with evidence: `stream-test.log`",
      };
    }
    if (providerMode === "streaming-final-progress") {
      streamingFinalProgressCalls += 1;
      if (streamingFinalProgressCalls === 1) {
        const output = "REPORT:progress\nstreamed final progress completed";
        await request.onProgress?.(output);
        return {
          provider: "codex",
          sessionId: request.sessionId || "mock-thread",
          publicSessionId: request.publicSessionId,
          cwd: request.cwd,
          output,
        };
      }
      return {
        provider: "codex",
        sessionId: request.sessionId || "mock-thread",
        publicSessionId: request.publicSessionId,
        cwd: request.cwd,
        output: "REPORT:result\nstreamed continuation completed with evidence: `stream-final.log`",
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

function callbackUpdate(data, sourceMessageId = messageId++) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 111, is_bot: false, first_name: "Tester", username: "tester" },
      message: {
        message_id: sourceMessageId,
        date: now(),
        chat: { id: 111222333, type: "private", first_name: "Tester", username: "tester" },
        text: "queue controls",
      },
      chat_instance: "selftest",
      data,
    },
  };
}

async function send(text) {
  await injectedBot.handleUpdates([update(text)]);
}

async function click(data) {
  await injectedBot.handleUpdates([callbackUpdate(data)]);
}

function findInlineButton(call, label) {
  if (!call?.reply_markup) {
    return undefined;
  }
  const markup = JSON.parse(call.reply_markup);
  return markup.inline_keyboard?.flat().find((button) => button.text === label);
}

async function readTelegramCalls() {
  return (await fs.readFile(telegramCalls, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [method, chatId, textB64 = "", replyMarkupB64 = ""] = line.split("\t");
      return {
        method,
        chat_id: chatId,
        text: Buffer.from(textB64, "base64").toString("utf8"),
        reply_markup: Buffer.from(replyMarkupB64, "base64").toString("utf8"),
      };
    });
}

async function waitForTelegramCall(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const calls = await readTelegramCalls();
    const match = [...calls].reverse().find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Telegram self-test call.");
}

await send("/start codex");
await send("/option retry 6");
await send("/option timeout 600");
await send("/option intent 4");
await send("/option reasoning high");
if (process.env.CODEX_REASONING_EFFORT !== "high" || !(await fs.readFile(path.join(dataDir, ".env"), "utf8")).includes("CODEX_REASONING_EFFORT=high")) {
  throw new Error("Reasoning option was not applied and persisted");
}
await send("/option reasoning invalid");
if (process.env.CODEX_REASONING_EFFORT !== "high") throw new Error("Invalid reasoning changed runtime setting");
await send("/option reasoning medium");
await send("/secret set REMOTEAGENT_TRANSFER_PASSPHRASE correct-horse-battery-staple");
await send("/secret set API_TOKEN telegram-secret-export-value");
await send("/secret export REMOTEAGENT_TRANSFER_PASSPHRASE API_TOKEN");
await send("같은 값을 봐야하는데 로직문제네? 확인해줘\\n이미 수정되어 있을 수 있어.\\n나한테 수정했다고 보고했었거든");
await send("/state");
await fs.writeFile(rateLimitOnce, "once", "utf8");
const rateLimitStartedAt = Date.now();
await send("/status");
const rateLimitElapsedMs = Date.now() - rateLimitStartedAt;
if (rateLimitElapsedMs < 1000) {
  throw new Error(`Telegram retry_after was not honored: elapsedMs=${rateLimitElapsedMs}`);
}

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
if (/^TELEGRAM_UNTAGGED_INTENT_RETRIES=/m.test(envText)) {
  throw new Error("Retired intent option should not persist configuration");
}

const importedSecretDataDir = path.join(tmp, "imported-secret-data");
const importedSecretResult = await importSecrets(
  importedSecretDataDir,
  capturedDocument,
  "correct-horse-battery-staple",
);
if (importedSecretResult.imported !== 1) {
  throw new Error(`Expected one Telegram-exported Secret, got ${importedSecretResult.imported}`);
}
const importedSecretStore = JSON.parse(
  await fs.readFile(path.join(importedSecretDataDir, "managed", "secrets.json"), "utf8"),
);
if (importedSecretStore.API_TOKEN?.value !== "telegram-secret-export-value") {
  throw new Error("Telegram Secret export did not preserve the selected Secret value");
}
if (importedSecretStore.REMOTEAGENT_TRANSFER_PASSPHRASE) {
  throw new Error("Telegram Secret export included its transfer passphrase key");
}
const secretTelegramCalls = await readTelegramCalls();
if (secretTelegramCalls.filter((call) => call.method === "deleteMessage").length < 2) {
  throw new Error("Secret source messages were not deleted after storage");
}
if (!secretTelegramCalls.some((call) => call.method === "sendDocument")) {
  throw new Error("Encrypted Secret bundle was not sent as a Telegram document");
}

const sessionWorkspace = session.workspace;
await fs.mkdir(path.join(sessionWorkspace, "node_modules", "left-pad"), { recursive: true });
await fs.mkdir(path.join(sessionWorkspace, "src"), { recursive: true });
await fs.writeFile(path.join(sessionWorkspace, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
await fs.writeFile(path.join(sessionWorkspace, "src", "keep.ts"), "export const keep = true;\n", "utf8");
await fs.writeFile(path.join(sessionWorkspace, "debug.log"), "temporary log\n", "utf8");
await fs.writeFile(path.join(sessionWorkspace, "TODO.md"), "- keep cleanup notes\n", "utf8");
await send("/cleanup");
await fs.access(path.join(sessionWorkspace, "TODO.md"));
if (await pathExists(path.join(sessionWorkspace, "node_modules"))) {
  throw new Error("/cleanup did not remove node_modules");
}
if (await pathExists(path.join(sessionWorkspace, "debug.log"))) {
  throw new Error("/cleanup did not remove log file");
}
if (await pathExists(path.join(sessionWorkspace, "src"))) {
  throw new Error("/cleanup did not remove regular workspace contents");
}

const orphanWorkspace = path.join(workspaceRoot, "orphan123");
const referencedWorkspace = sessionWorkspace;
await fs.mkdir(orphanWorkspace, { recursive: true });
await fs.writeFile(path.join(orphanWorkspace, "artifact.tmp"), "orphan\n", "utf8");
const workspaceCleanup = new WorkspaceCleanupService(dataDir, workspaceRoot);
const orphanResult = await workspaceCleanup.cleanupOrphanWorkspaces();
if (!/removed=1/.test(orphanResult)) {
  throw new Error(`Expected one orphan workspace removal, got: ${orphanResult}`);
}
if (await pathExists(orphanWorkspace)) {
  throw new Error("Orphan workspace was not removed");
}
if (!(await pathExists(referencedWorkspace))) {
  throw new Error("Referenced workspace was removed unexpectedly");
}

const missingStateDataDir = path.join(tmp, "missing-state-data");
const missingStateWorkspaceRoot = path.join(tmp, "missing-state-workspaces");
const shouldRemain = path.join(missingStateWorkspaceRoot, "should-remain");
await fs.mkdir(shouldRemain, { recursive: true });
const missingStateCleanup = new WorkspaceCleanupService(missingStateDataDir, missingStateWorkspaceRoot);
let refusedMissingState = false;
try {
  await missingStateCleanup.cleanupOrphanWorkspaces();
} catch {
  refusedMissingState = true;
}
if (!refusedMissingState) {
  throw new Error("Workspace cleanup should refuse to run when state.json is missing");
}
if (!(await pathExists(shouldRemain))) {
  throw new Error("Workspace cleanup removed a workspace when state.json was missing");
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
if (!calls.some((call) => call.method === "sendMessage" && /intent option has been retired/.test(call.text))) {
  throw new Error(`Did not see option intent acknowledgement. Calls: ${JSON.stringify(calls, null, 2)}`);
}
if (!calls.some((call) => call.method === "sendMessage" && /Workspace cleanup finished for S001/.test(call.text))) {
  throw new Error(`Did not see workspace cleanup acknowledgement. Calls: ${JSON.stringify(calls, null, 2)}`);
}
if (calls.some((call) => /미완료 TODO|\/task|새 작업으로 접수/.test(call.text))) {
  throw new Error(`Task gate language leaked to Telegram replies. Calls: ${JSON.stringify(calls, null, 2)}`);
}

await send("/login");
const loginMenu = await waitForTelegramCall(call => call.text.includes("Choose an account to authenticate"));
for (const label of ["GitHub", "Codex", "Claude"]) {
  if (!findInlineButton(loginMenu, label)?.callback_data?.startsWith("remoteagent:action:")) {
    throw new Error(`Missing login button: ${label}`);
  }
}

await send("/new");
await send("/list");
const sessionListCall = await waitForTelegramCall((call) => call.text.includes("Sessions (2/2)"));
const firstSessionButton = findInlineButton(sessionListCall, `S001 · ${path.basename(session.workspace)}`);
if (!firstSessionButton?.callback_data?.startsWith("remoteagent:action:")) {
  throw new Error(`Session switch button is missing: ${sessionListCall.reply_markup}`);
}
await click(firstSessionButton.callback_data);
await waitForTelegramCall((call) => call.text.includes("Switched this chat to session S001."));

await send("/model");
const modelListCall = await waitForTelegramCall((call) => call.text.includes("availablePresets:"));
const restoreButton = findInlineButton(modelListCall, "원래 모델 복귀");
if (!restoreButton?.callback_data) throw new Error("Model restore button missing");
const fallbackPath = path.join(dataDir, "codex-usage-fallback.json");
const fallbackFixture = JSON.stringify({fallbackModel: "gpt-5.3-codex-spark", activatedAt: new Date().toISOString(), resetAt: "2099-01-01T00:00:00Z"});
const beforeRestore = await fs.readFile(path.join(dataDir, "state.json"), "utf8");
await fs.writeFile(fallbackPath, fallbackFixture);
await click(restoreButton.callback_data);
if (await pathExists(fallbackPath)) throw new Error("Restore button did not clear fallback");
await fs.writeFile(fallbackPath, fallbackFixture);
await send("/model restore");
await send("/model restore");
if (await pathExists(fallbackPath)) throw new Error("Restore command did not clear fallback");
const afterRestore = await fs.readFile(path.join(dataDir, "state.json"), "utf8");
if (JSON.stringify(JSON.parse(beforeRestore).sessions) !== JSON.stringify(JSON.parse(afterRestore).sessions)) throw new Error("Restore changed sessions");
const modelButton = findInlineButton(modelListCall, "gpt-5.6-terra");
if (!modelButton?.callback_data) {
  throw new Error(`Model selection button is missing: ${modelListCall.reply_markup}`);
}
await click(modelButton.callback_data);
await waitForTelegramCall((call) => call.text.includes("Set codex model to gpt-5.6-terra."));
const modelState = JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
if (modelState.sessions[session.sessionId]?.codex?.model !== "gpt-5.6-terra") {
  throw new Error("Model button did not update the bound session model");
}

await send("/option");
const optionListCall = await waitForTelegramCall((call) => call.text.startsWith("Runtime options"));
const timeoutButton = findInlineButton(optionListCall, "Timeout");
if (!timeoutButton?.callback_data) {
  throw new Error(`Runtime option button is missing: ${optionListCall.reply_markup}`);
}
await click(timeoutButton.callback_data);
await waitForTelegramCall((call) => call.text.includes("Current provider execution timeout: 600s"));

await send("/sandbox");
const sandboxListCall = await waitForTelegramCall((call) => call.text.startsWith("Codex sandbox"));
const readOnlyButton = findInlineButton(sandboxListCall, "read-only");
const dangerButton = findInlineButton(sandboxListCall, "danger-full-access");
if (!readOnlyButton?.callback_data || !dangerButton?.callback_data) {
  throw new Error(`Sandbox selection buttons are missing: ${sandboxListCall.reply_markup}`);
}
await click(readOnlyButton.callback_data);
await waitForTelegramCall((call) => call.text.includes("Set Codex sandbox to read-only."));
await click(dangerButton.callback_data);
const sandboxConfirmCall = await waitForTelegramCall((call) => call.text.includes("Confirm Codex sandbox change"));
if (!findInlineButton(sandboxConfirmCall, "Confirm danger-full-access")?.callback_data) {
  throw new Error(`Danger sandbox confirmation button is missing: ${sandboxConfirmCall.reply_markup}`);
}

await send("/macro set button-test inspect the callback path");
await send("/batch start");
await send("/macro");
const macroListCall = await waitForTelegramCall((call) => call.text.includes("Macros (1)"));
const macroButton = findInlineButton(macroListCall, "button-test");
if (!macroButton?.callback_data) {
  throw new Error(`Macro execution button is missing: ${macroListCall.reply_markup}`);
}
await click(macroButton.callback_data);
await send("/batch send");
await waitForTelegramCall((call) => call.text.includes("mock provider completed"));

const longTextProviderCallsBefore = providerCalls.length;
const longPartOne = `LONG_PART_ONE:${"a".repeat(2200)}`;
const longPartTwo = `LONG_PART_TWO:${"b".repeat(2200)}`;
providerMode = "success";
await send("/batch start");
await send(longPartOne);
await send(longPartTwo);
await send("/batch send");
await waitForTelegramCall((call) => call.text.includes("mock provider completed"));

const longTextProviderCalls = providerCalls.slice(longTextProviderCallsBefore);
if (longTextProviderCalls.length !== 1) {
  throw new Error(`Split long Telegram input should make one provider call, got ${longTextProviderCalls.length}`);
}
const longTextProviderMessage = longTextProviderCalls[0]?.message ?? "";
if (!longTextProviderMessage.includes("stored as a UTF-8 text file")) {
  throw new Error(`Long Telegram input was not replaced with a file prompt: ${longTextProviderMessage}`);
}
if (longTextProviderMessage.includes(longPartOne) || longTextProviderMessage.includes(longPartTwo)) {
  throw new Error("Long Telegram input was copied into the provider prompt instead of being file-backed");
}
const longTextFile = longTextProviderMessage.match(/^File: (.+\.txt)$/m)?.[1];
if (!longTextFile) {
  throw new Error(`Long Telegram input prompt did not include an absolute text file path: ${longTextProviderMessage}`);
}
const expectedLongTextDirectory = path.join(
  dataDir,
  "uploads",
  "telegram",
  "remoteagent_test_bot",
  "111222333",
);
if (path.dirname(longTextFile) !== expectedLongTextDirectory) {
  throw new Error(`Long Telegram input was stored outside the managed upload directory: ${longTextFile}`);
}
const storedLongText = await fs.readFile(longTextFile, "utf8");
if (storedLongText !== `${longPartOne}\n${longPartTwo}`) {
  throw new Error("Stored Telegram text did not preserve all batched message parts in order");
}
const longTextMode = (await fs.stat(longTextFile)).mode & 0o777;
if (longTextMode !== 0o600) {
  throw new Error(`Stored Telegram text permissions should be 0600, got ${longTextMode.toString(8)}`);
}

await fs.appendFile(path.join(dataDir, ".env"), [
  "TELEGRAM_BOT_TOKENS=000000:test-token",
  "TELEGRAM_BOT_USERNAMES=remoteagent_test_bot",
  "",
].join("\n"), "utf8");
await send("/bots");
const botsCall = await waitForTelegramCall((call) => call.text.includes("Configured bots (1)"));
const botLink = findInlineButton(botsCall, "@bot_0");
const refreshButton = findInlineButton(botsCall, "Refresh");
if (botLink?.url !== "https://t.me/bot_0" || !refreshButton?.callback_data) {
  throw new Error(`Bot link or refresh button is missing: ${botsCall.reply_markup}`);
}
await click(refreshButton.callback_data);
const refreshedBotsCalls = (await readTelegramCalls()).filter((call) => call.text.includes("Configured bots (1)"));
if (refreshedBotsCalls.length < 2) {
  throw new Error("Bot refresh callback did not render the bot list again");
}

const usageProviderCallsBefore = providerCalls.length;
providerMode = "usage-limit";
await send("/batch start");
await send("usage limit fallback regression test");
await send("/batch send");
const usageCalls = await readTelegramCalls();
const usageProviderModels = providerCalls.slice(usageProviderCallsBefore).map((call) => call.model);
if (usageLimitCalls !== 2 || usageProviderModels.join(",") !== "gpt-5.6-terra,gpt-5.3-codex-spark") {
  throw new Error(`Usage fallback did not make one primary and one Spark call: ${JSON.stringify(usageProviderModels)}`);
}
if (!usageCalls.some((call) => call.method === "sendMessage" && call.text.includes("임시 전환합니다"))) {
  throw new Error("Usage fallback transition notice was not delivered to Telegram");
}
if (!usageCalls.some((call) =>
  call.method === "sendMessage"
  && call.text.includes("[CODEX | gpt-5.3-codex-spark | S001]")
  && call.text.includes("usage fallback completed")
)) {
  throw new Error("Usage fallback result did not identify the actual Spark execution model");
}
const usageFallbackState = JSON.parse(await fs.readFile(path.join(dataDir, "codex-usage-fallback.json"), "utf8"));
if (usageFallbackState.fallbackModel !== "gpt-5.3-codex-spark") {
  throw new Error(`Usage fallback state was not persisted: ${JSON.stringify(usageFallbackState)}`);
}
const usageSessionState = JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
if (usageSessionState.sessions[session.sessionId]?.codex?.model !== "gpt-5.6-terra") {
  throw new Error("Temporary usage fallback overwrote the session's primary model");
}
await fs.unlink(path.join(dataDir, "codex-usage-fallback.json"));

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
if (untaggedIntentCalls !== 1 || !untaggedCalls.some(call => call.text.includes("계속 진행해서 확인하겠습니다."))) {
  throw new Error("Untagged response was not delivered in one execution");
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
if (missingEvidenceCalls !== 1 || !evidenceCalls.some(call => call.text.includes("수정 완료했습니다."))) {
  throw new Error("Final response was not delivered in one execution");
}
for (const body of [
  "플레이스미션을 누락했고, 표시 방식도 잘못 정리했습니다.\n‘더보기 목록’이 아니라 기존 넘기기 UI를 재사용하는 요구로 정정합니다.",
  "앞선 답변은 요구사항 정정이며, 코드 수정·검증·병합 완료 보고가 아닙니다. 이번 정정으로 변경한 파일이나 커밋은 없습니다.",
  "sudo 권한이 필요하지 않습니다. API key 변경도 없습니다.",
]) {
  providerMode = "literal-result";
  literalResponse = "REPORT:result\n" + body;
  const countBefore = providerCalls.length;
  await send("/batch start");
  await send("S091 regression");
  await send("/batch send");
  if (providerCalls.length !== countBefore + 1) throw new Error("Result triggered extra provider execution");
  const delivered = await readTelegramCalls();
  if (!delivered.some(call => call.text.includes(body))) throw new Error("Result body not delivered");
}

providerMode = "streaming-progress";
await send("/batch start");
await send("streaming progress regression test");
await send("/batch send");

const streamingCalls = await readTelegramCalls();
for (const phase of ["streamed phase one completed", "streamed phase two completed"]) {
  const matches = streamingCalls.filter((call) => call.method === "sendMessage" && call.text.includes(phase));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one streamed Telegram progress message for ${phase}, got ${matches.length}`);
  }
}
if (!streamingCalls.some((call) => call.method === "sendMessage" && call.text.includes("streamed provider completed"))) {
  throw new Error("Streaming provider final result was not delivered");
}

providerMode = "streaming-final-progress";
await send("/batch start");
await send("streaming final progress deduplication test");
await send("/batch send");
const streamingFinalCalls = await readTelegramCalls();
const streamedFinalProgressMessages = streamingFinalCalls.filter((call) =>
  call.method === "sendMessage" && call.text.includes("streamed final progress completed")
);
if (streamedFinalProgressMessages.length !== 1 || streamingFinalProgressCalls !== 2) {
  throw new Error(
    `Final streamed progress was not deduplicated: messages=${streamedFinalProgressMessages.length} providerCalls=${streamingFinalProgressCalls}`,
  );
}

const queueProviderCallsBefore = providerCalls.length;
providerMode = "queue-hold";
queueHoldStartedPromise = new Promise((resolve) => {
  queueHoldStartedResolve = resolve;
});
queueHoldReleasePromise = new Promise((resolve) => {
  queueHoldReleaseResolve = resolve;
});

await send("/batch start");
await send("active queue regression test");
const activeQueueSend = send("/batch send");
await queueHoldStartedPromise;

await send("/batch start");
await send("first queued instruction");
const firstQueuedSend = send("/batch send");
const firstQueueNotice = await waitForTelegramCall((call) => /Queued instruction Q\d+/.test(call.text));
const firstQueueId = firstQueueNotice.text.match(/Queued instruction (Q\d+)/)?.[1];
if (!firstQueueId) {
  throw new Error(`First queued instruction did not receive an id: ${firstQueueNotice.text}`);
}
const firstQueueNotices = (await readTelegramCalls()).filter((call) =>
  call.method === "sendMessage" && call.text.includes(`Queued instruction ${firstQueueId} for`)
);
if (firstQueueNotices.length !== 1) {
  throw new Error(`Queue notice should be one Telegram message, got ${firstQueueNotices.length}`);
}
if (!firstQueueNotice.reply_markup.includes(`remoteagent:queue:remove:${firstQueueId}`)
  || !firstQueueNotice.reply_markup.includes("remoteagent:queue:del")) {
  throw new Error(`Queue notice buttons are missing: ${firstQueueNotice.reply_markup}`);
}

await send("/batch start");
await send("second queued instruction");
const secondQueuedSend = send("/batch send");
const secondQueueNotice = await waitForTelegramCall((call) => {
  const queueId = call.text.match(/Queued instruction (Q\d+)/)?.[1];
  return Boolean(queueId && queueId !== firstQueueId);
});
const secondQueueId = secondQueueNotice.text.match(/Queued instruction (Q\d+)/)?.[1];
if (!secondQueueId) {
  throw new Error(`Second queued instruction did not receive an id: ${secondQueueNotice.text}`);
}

await send("/queue");
const queueListCall = await waitForTelegramCall((call) =>
  call.text.includes(firstQueueId) && call.text.includes(secondQueueId)
);
if (!/Queued instructions for S001 \(2\)/.test(queueListCall.text)) {
  throw new Error(`Queue list did not report both entries: ${queueListCall.text}`);
}

await click(`remoteagent:queue:remove:${firstQueueId}`);
await waitForTelegramCall((call) => call.text.includes(`Removed queued instruction ${firstQueueId}`));
await click("remoteagent:queue:del");
await waitForTelegramCall((call) => call.text.includes(`Removed queued instruction ${secondQueueId}`));

queueHoldReleaseResolve?.();
await Promise.all([activeQueueSend, firstQueuedSend, secondQueuedSend]);
if (providerCalls.length !== queueProviderCallsBefore + 1) {
  throw new Error(`Removed queued instructions reached the provider: ${providerCalls.length - queueProviderCallsBefore} calls`);
}

providerMode = "explicit-status";
explicitResponses = ["REPORT:progress\nsudo 권한 변경은 필요 없습니다. 다음 단계를 진행합니다.", "REPORT:result\nexplicit continuation finished"];
const explicitBefore = providerCalls.length;
await send("/batch start");
await send("explicit status regression");
await send("/batch send");
if (providerCalls.length !== explicitBefore + 2) throw new Error("Explicit progress was overridden by body words");
explicitResponses = ["REPORT:blocked\n명시적으로 중단합니다."];
const blockedBefore = providerCalls.length;
await send("/batch start");
await send("explicit blocked regression");
await send("/batch send");
if (providerCalls.length !== blockedBefore + 1) throw new Error("Explicit blocked response retried");

providerMode = "stop-hold";
queueHoldStartedPromise = new Promise(resolve => { queueHoldStartedResolve = resolve; });
queueHoldReleasePromise = new Promise(resolve => { queueHoldReleaseResolve = resolve; });
const stopBefore = providerCalls.length;
await send("/batch start");
await send("stop regression");
const stoppedRun = send("/batch send");
await queueHoldStartedPromise;
await send("/stop");
queueHoldReleaseResolve();
await stoppedRun;
if (providerCalls.length !== stopBefore + 1) throw new Error("Stop allowed automatic continuation");

console.log(JSON.stringify({
  ok: true,
  dataDir,
  session: session.publicId,
  developmentState: /기프티쇼 개발 진행해/.test(developmentCurrent),
  recoveredTodoItems: recoveredActive.length,
  retryOption: 6,
  timeoutOptionMs: 600000,
  intentOptionRetired: true,
  providerCalls: providerCalls.length,
  untaggedIntentCalls,
  missingEvidenceCalls,
  streamingProgress: true,
  streamingFinalProgressDeduplicated: true,
  queueRemoveById: firstQueueId,
  queueRemoveLatest: secondQueueId,
  timeoutFinalMessage: true,
  usageLimitFallback: true,
  longTelegramTextStoredAsFile: true,
  telegramSendMessages: evidenceCalls.filter((call) => call.method === "sendMessage").length,
  telegramRateLimitElapsedMs: rateLimitElapsedMs,
}, null, 2));

process.exit(0);

async function pathExists(target) {
  return fs.access(target).then(() => true, () => false);
}
