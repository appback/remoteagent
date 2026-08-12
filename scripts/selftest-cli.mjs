#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fetchTelegramBotIdentity,
  registerTelegramBot,
  waitForTelegramOwner,
} from "../dist/services/cli-config-service.js";
import { buildProviderEnv, buildRuntimePath } from "../dist/adapters/runtime-env.js";
import { exportSecrets, importSecrets } from "../dist/services/secret-transfer-service.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "remoteagent-cli-selftest-"));
const sourceDataDir = path.join(root, "source");
const targetDataDir = path.join(root, "target");
const bundlePath = path.join(root, "transfer.ra-secrets");
const selectedBundlePath = path.join(root, "selected-transfer.ra-secrets");
const passphrase = "correct-horse-battery-staple";

try {
  const expectedNodeBin = path.join(root, "nvm", "bin");
  const expectedHome = path.join(root, "home");
  const runtimePath = buildRuntimePath(
    ["/usr/local/bin", "/usr/bin", "/usr/bin"].join(path.delimiter),
    path.join(expectedNodeBin, "node"),
    expectedHome,
  ).split(path.delimiter);
  assert.deepEqual(runtimePath, [
    expectedNodeBin,
    path.join(expectedHome, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
  ]);
  const providerEnv = buildProviderEnv();
  assert.equal(providerEnv.PATH?.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.ok(providerEnv.PATH?.split(path.delimiter).includes(path.join(os.homedir(), ".local", "bin")));

  const binDir = path.join(root, "bin");
  const curlArgsPath = path.join(root, "curl-args.txt");
  const curlUpdateCallsPath = path.join(root, "curl-update-calls.txt");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "curl"), `#!/usr/bin/env bash
printf '%s\\n' "$@" > ${JSON.stringify(curlArgsPath)}
if printf '%s\\n' "$@" | grep -q '/getUpdates'; then
  count=0
  if [ -f ${JSON.stringify(curlUpdateCallsPath)} ]; then
    count="$(cat ${JSON.stringify(curlUpdateCallsPath)})"
  fi
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(curlUpdateCallsPath)}
  if [ "$count" -eq 1 ]; then
    printf '{"ok":true,"result":[{"update_id":41,"message":{"text":"/start stale_payload","chat":{"id":777,"type":"private"},"from":{"id":777,"is_bot":false,"username":"stale"}}}]}'
  else
    printf '{"ok":true,"result":[{"update_id":42,"message":{"text":"/start ra_selftest","chat":{"id":8202993989,"type":"private"},"from":{"id":8202993989,"is_bot":false,"username":"roy","first_name":"Roy"}}}]}'
  fi
else
  printf '{"ok":true,"result":{"id":100000,"username":"bootstrap_test_bot"}}'
fi
`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  const fetchedIdentity = await fetchTelegramBotIdentity("100000:abcdefghijklmnopqrstuvwxyz_123456");
  assert.deepEqual(fetchedIdentity, { id: 100000, username: "bootstrap_test_bot" });
  const curlArgs = await fs.readFile(curlArgsPath, "utf8");
  assert.match(curlArgs, /^-4$/m);
  assert.match(curlArgs, /\/getMe$/m);
  const detectedOwner = await waitForTelegramOwner(
    "100000:abcdefghijklmnopqrstuvwxyz_123456",
    "ra_selftest",
    2_000,
  );
  assert.deepEqual(detectedOwner, {
    id: "8202993989",
    username: "roy",
    displayName: "Roy",
  });
  const ownerCurlArgs = await fs.readFile(curlArgsPath, "utf8");
  assert.match(ownerCurlArgs, /^-4$/m);
  assert.match(ownerCurlArgs, /^offset=42$/m);
  process.env.PATH = originalPath;

  await fs.mkdir(sourceDataDir, { recursive: true });
  await fs.writeFile(path.join(sourceDataDir, ".env"), [
    "TELEGRAM_BOT_TOKEN=your-telegram-bot-token",
    "TELEGRAM_BOT_TOKENS=",
    "TELEGRAM_OWNER_ID=",
    "DEFAULT_MODE=codex",
    "",
  ].join("\n"), { mode: 0o600 });

  const first = await registerTelegramBot({
    dataDir: sourceDataDir,
    token: "100001:abcdefghijklmnopqrstuvwxyz_123456",
    ownerId: "8202993989",
    identity: { id: 100001, username: "first_remoteagent_bot" },
  });
  assert.equal(first.added, true);
  assert.equal(first.botCount, 1);

  const second = await registerTelegramBot({
    dataDir: sourceDataDir,
    token: "100002:abcdefghijklmnopqrstuvwxyz_654321",
    ownerId: "8202993989",
    identity: { id: 100002, username: "second_remoteagent_bot" },
  });
  assert.equal(second.botCount, 2);
  const envText = await fs.readFile(path.join(sourceDataDir, ".env"), "utf8");
  assert.match(envText, /DEFAULT_MODE=codex/);
  assert.match(envText, /TELEGRAM_OWNER_ID=8202993989/);
  assert.doesNotMatch(envText, /your-telegram-bot-token/);
  assert.match(envText, /TELEGRAM_BOT_USERNAMES=first_remoteagent_bot,second_remoteagent_bot/);

  const sourceSecrets = {
    API_TOKEN: {
      key: "API_TOKEN",
      value: "plain-value-must-not-appear-in-bundle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    DB_PASSWORD: {
      key: "DB_PASSWORD",
      value: "another-private-value",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  };
  await fs.mkdir(path.join(sourceDataDir, "managed"), { recursive: true });
  await fs.writeFile(
    path.join(sourceDataDir, "managed", "secrets.json"),
    `${JSON.stringify(sourceSecrets, null, 2)}\n`,
    { mode: 0o600 },
  );

  const exported = await exportSecrets(sourceDataDir, bundlePath, passphrase);
  assert.equal(exported.count, 2);
  const bundleText = await fs.readFile(bundlePath, "utf8");
  assert.doesNotMatch(bundleText, /plain-value-must-not-appear-in-bundle/);
  assert.doesNotMatch(bundleText, /another-private-value/);
  assert.match(bundleText, /remoteagent-secret-bundle/);
  assert.match(bundleText, /"compression": "gzip"/);

  const selectedExport = await exportSecrets(sourceDataDir, selectedBundlePath, passphrase, {
    includeKeys: ["API_TOKEN"],
  });
  assert.equal(selectedExport.count, 1);
  const selectedDataDir = path.join(root, "selected-target");
  await importSecrets(selectedDataDir, selectedBundlePath, passphrase);
  const selectedSecrets = JSON.parse(await fs.readFile(path.join(selectedDataDir, "managed", "secrets.json"), "utf8"));
  assert.deepEqual(Object.keys(selectedSecrets), ["API_TOKEN"]);

  await fs.mkdir(path.join(targetDataDir, "managed"), { recursive: true });
  await fs.writeFile(path.join(targetDataDir, "managed", "secrets.json"), JSON.stringify({
    API_TOKEN: {
      key: "API_TOKEN",
      value: "old-value",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    KEEP_ME: {
      key: "KEEP_ME",
      value: "kept-value",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  }, null, 2), { mode: 0o600 });

  const imported = await importSecrets(targetDataDir, bundlePath, passphrase);
  assert.equal(imported.imported, 2);
  assert.equal(imported.overwritten, 1);
  assert.equal(imported.total, 3);
  assert.ok(imported.backupPath);
  const importedSecrets = JSON.parse(await fs.readFile(path.join(targetDataDir, "managed", "secrets.json"), "utf8"));
  assert.equal(importedSecrets.API_TOKEN.value, sourceSecrets.API_TOKEN.value);
  assert.equal(importedSecrets.DB_PASSWORD.value, sourceSecrets.DB_PASSWORD.value);
  assert.equal(importedSecrets.KEEP_ME.value, "kept-value");

  await assert.rejects(
    importSecrets(path.join(root, "wrong-passphrase"), bundlePath, "wrong-passphrase"),
    /could not be decrypted/,
  );

  console.log("RemoteAgent CLI self-test passed.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
