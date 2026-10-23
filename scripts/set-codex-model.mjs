#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../dist/store/file-store.js';
import { acquireProcessLock, releaseProcessLock } from '../dist/services/runtime-lock.js';

const [model, dataDir = path.join(os.homedir(), '.remoteagent'), ...extra] = process.argv.slice(2);
if (model !== 'gpt-6.1-sol' || extra.length) throw Error('Usage: node scripts/set-codex-model.mjs gpt-6.1-sol [data-dir] (stop RemoteAgent first)');
const lock = await acquireProcessLock(dataDir);
try {
  const source = path.join(dataDir, 'state.json');
  const backup = path.join(dataDir, 'backups', `model-${Date.now()}`);
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  await fs.copyFile(source, path.join(backup, 'state.json'));
  await fs.chmod(path.join(backup, 'state.json'), 0o600);
  const store = new FileStore(dataDir, 'codex');
  const changed = await store.setAllCodexModels(model);
  console.log(JSON.stringify({ model, changed, backup }));
} finally {
  releaseProcessLock(lock);
}
