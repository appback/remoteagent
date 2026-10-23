import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FileStore } from '../dist/store/file-store.js';
import { acquireProcessLock, releaseProcessLock } from '../dist/services/runtime-lock.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remoteagent-model-migration-'));
try {
  const store = new FileStore(dir, 'codex');
  await store.init();
  const session = await store.createSessionForChat('bot', 'chat', '/unchanged', 'codex');
  await store.upsertProviderForChat('bot', 'chat', 'codex', { provider: 'codex', model: 'gpt-6-astra', sessionId: 'original-thread', cwd: '/unchanged', pairedAt: new Date().toISOString() }, '/unchanged');
  const before = await store.getSession(session.session.sessionId);
  const script = new URL('./set-codex-model.mjs', import.meta.url);
  const lock = await acquireProcessLock(dir);
  assert.throws(() => execFileSync(process.execPath, [script.pathname, 'gpt-6.1-sol', dir], { stdio: 'pipe' }), /already running/);
  releaseProcessLock(lock);
  const result = JSON.parse(execFileSync(process.execPath, [script.pathname, 'gpt-6.1-sol', dir], { encoding: 'utf8' }));
  assert.equal(result.changed.length, 1);
  const after = await store.getSession(session.session.sessionId);
  assert.equal(after.codex.model, 'gpt-6.1-sol');
  after.codex.model = before.codex.model;
  assert.deepEqual(after, before);
  const again = JSON.parse(execFileSync(process.execPath, [script.pathname, 'gpt-6.1-sol', dir], { encoding: 'utf8' }));
  assert.deepEqual(again.changed, []);
  console.log('PASS Codex model migration: live runtime rejected, thread and workspace preserved, idempotent');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
