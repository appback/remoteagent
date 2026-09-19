import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoginService, loginHints } from '../dist/services/login-service.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-login-test-'));
const bin = path.join(dir, 'fake-cli');
const state = path.join(dir, 'authenticated');
const notices = [];
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for test condition');
};
try {
  await fs.writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('fake 1.0'); process.exit(0); }
if (process.argv.includes('status')) {
  console.log(JSON.stringify({loggedIn:fs.existsSync(${JSON.stringify(state)})}));
  process.exit(fs.existsSync(${JSON.stringify(state)}) ? 0 : 1);
}
console.log('First copy your one-time code: ABCD-EFGH');
console.log('https://github.com/login/device');
console.log('ACCESS_TOKEN_MUST_NOT_LEAK');
setTimeout(() => {fs.writeFileSync(${JSON.stringify(state)}, 'ok'); process.exit(0);}, 400);
`, { mode: 0o700 });
  const binaries = { github: bin, codex: bin, claude: bin };
  const service = new LoginService(4000, binaries);
  const notify = async text => { notices.push(text); };
  const first = service.start('github', false, notify);
  assert.match((await new LoginService(4000, binaries).start('github', false, notify)).text, /already in progress/);
  assert.match((await first).text, /ABCD-EFGH/);
  await waitFor(() => notices.some(text => text.includes('verified')));
  assert.equal((await service.start('github', false, notify)).alreadyLoggedIn, true);
  notices.length = 0;
  assert.match((await service.start('github', true, notify)).text, /login\/device/);
  await waitFor(() => notices.some(text => text.includes('verified')));
  assert.ok(notices.every(text => !text.includes('ACCESS_TOKEN_MUST_NOT_LEAK')));
  await fs.unlink(state);
  notices.length = 0;
  await new LoginService(100, binaries).start('claude', false, notify);
  await waitFor(() => notices.some(text => text.includes('expired')));
  await assert.rejects(new LoginService(100, { codex: path.join(dir, 'missing') }).start('codex', false, notify), /not installed/);
  await fs.chmod(bin, 0o600);
  await assert.rejects(service.isInstalled('github'), /EACCES/);
  await fs.chmod(bin, 0o700);
  assert.equal(loginHints('secret token only'), undefined);
  assert.match(loginHints('https://auth.openai.com/codex/device\nABCD-EFGHI'), /ABCD-EFGHI/);
  console.log('PASS login: URL/code, status, cross-bot lock, reauthentication, completion, expiry, missing CLI, output filtering');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
