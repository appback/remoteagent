#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeService } from "../dist/services/bridge-service.js";
import {
  CODEX_USAGE_FALLBACK_MODEL,
  CodexUsageFallbackService,
  parseCodexUsageLimit,
} from "../dist/services/codex-usage-fallback-service.js";
import { FileStore } from "../dist/store/file-store.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "remoteagent-model-fallback-"));
const dataDir = path.join(root, "data");
const workspaceRoot = path.join(root, "workspaces");
const defaultWorkspace = path.join(root, "default-workspace");
const fallbackStatePath = path.join(dataDir, "codex-usage-fallback.json");
const primaryModel = "gpt-5.6-sol";
const usageError = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 27th, 2099 3:52 AM.";

try {
  await fs.mkdir(defaultWorkspace, { recursive: true });
  const parsed = parseCodexUsageLimit(usageError);
  assert.ok(parsed?.resetAt);
  assert.equal(parsed.resetAtLabel, "Aug 27th, 2099 3:52 AM");
  assert.equal(parseCodexUsageLimit("Selected model is at capacity."), undefined);
  assert.equal(parseCodexUsageLimit("Too Many Requests: retry after 5"), undefined);

  const store = new FileStore(dataDir, "codex");
  await store.init();
  const calls = [];
  const progress = [];
  let failPrimaryWithUsageLimit = true;
  let failFallbackWithUsageLimit = false;
  const provider = {
    async send(request) {
      calls.push({ model: request.model, message: request.message, sessionId: request.sessionId });
      if (request.model === primaryModel && failPrimaryWithUsageLimit) {
        throw new Error(usageError);
      }
      if (request.model === CODEX_USAGE_FALLBACK_MODEL && failFallbackWithUsageLimit) {
        throw new Error("You've hit your usage limit. Try again at Aug 28th, 2099 1:00 AM.");
      }
      return {
        provider: "codex",
        sessionId: request.sessionId || "thread-model-fallback",
        cwd: request.cwd,
        output: "REPORT:result\nmodel fallback self-test completed",
      };
    },
  };
  const createBridge = () => new BridgeService(
    store,
    { codex: provider },
    defaultWorkspace,
    workspaceRoot,
    (providerName) => providerName === "codex",
    "codex",
    "workspace-write",
  );

  let bridge = createBridge();
  const started = await bridge.startSession("test-bot", "test-chat", "codex");
  const originalSessionId = started.session.sessionId;
  const first = await bridge.routeMessage("test-bot", "test-chat", "first request", async (response) => {
    progress.push(response.output);
  });
  assert.deepEqual(calls.map((call) => call.model), [primaryModel, CODEX_USAGE_FALLBACK_MODEL]);
  assert.deepEqual(calls.map((call) => call.message), ["first request", "first request"]);
  assert.equal(first[0]?.model, CODEX_USAGE_FALLBACK_MODEL);
  assert.match(progress.join("\n"), /임시 전환합니다/);

  const afterFallback = await store.getChatSession("test-bot", "test-chat");
  assert.equal(afterFallback?.session.sessionId, originalSessionId);
  assert.equal(afterFallback?.session.codex?.model, primaryModel);
  assert.ok(await fs.stat(fallbackStatePath));

  calls.length = 0;
  bridge = createBridge();
  const otherSession = await bridge.startSession("other-bot", "other-chat", "codex");
  await bridge.routeMessage("other-bot", "other-chat", "second request");
  assert.deepEqual(calls.map((call) => call.model), [CODEX_USAGE_FALLBACK_MODEL]);
  assert.equal(calls[0]?.sessionId, undefined);
  const otherStoredSession = await store.getChatSession("other-bot", "other-chat");
  assert.equal(otherStoredSession?.session.sessionId, otherSession.session.sessionId);
  assert.equal(otherStoredSession?.session.codex?.model, primaryModel);

  const persisted = JSON.parse(await fs.readFile(fallbackStatePath, "utf8"));
  persisted.resetAt = "2000-01-01T00:00:00.000Z";
  await fs.writeFile(fallbackStatePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  calls.length = 0;
  progress.length = 0;
  failPrimaryWithUsageLimit = false;
  bridge = createBridge();
  const recovered = await bridge.routeMessage("test-bot", "test-chat", "after reset", async (response) => {
    progress.push(response.output);
  });
  assert.deepEqual(calls.map((call) => call.model), [primaryModel]);
  assert.equal(recovered[0]?.model, primaryModel);
  assert.match(progress.join("\n"), /원래 모델로 복귀했습니다/);
  await assert.rejects(fs.stat(fallbackStatePath), { code: "ENOENT" });

  const fallbackService = new CodexUsageFallbackService(dataDir);
  await fallbackService.activate(parseCodexUsageLimit("You've hit your usage limit.") ?? {});
  assert.equal(await fallbackService.read(), undefined);

  calls.length = 0;
  failPrimaryWithUsageLimit = true;
  failFallbackWithUsageLimit = true;
  bridge = createBridge();
  await assert.rejects(
    bridge.routeMessage("test-bot", "test-chat", "fallback exhausted"),
    /hit your usage limit/,
  );
  assert.deepEqual(calls.map((call) => call.model), [primaryModel, CODEX_USAGE_FALLBACK_MODEL]);

  console.log(JSON.stringify({
    ok: true,
    detectedExactUsageError: true,
    fallbackModel: CODEX_USAGE_FALLBACK_MODEL,
    primaryModelPreserved: true,
    fallbackPersistedAcrossBridgeRestart: true,
    fallbackSharedAcrossSessions: true,
    primaryRestoredAfterSuccessfulProbe: true,
    fallbackAttemptLimit: 1,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
