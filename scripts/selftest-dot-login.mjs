import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DotLoginService, saveSiteLogin } from '../dist/services/dot-login-service.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-login-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = { url: 'https://login.example.test/signin', username: 'synthetic-user', password: 'synthetic-password-only', allowAutoLogin: true };
  saveSiteLogin(dir, 'example', profile);
  let calls = 0;
  const browser = { currentUrl: async () => profile.url, fill: async (p, submit) => { calls++; return submit ? 'submitted' : 'filled'; } };
  return { dir, profile, browser, service: new DotLoginService(dir, browser), calls: () => calls };
}
test('fallback reuses shared Secret Store without exposing account/password in metadata or result', async t => {
  const { dir, service } = fixture(t);
  assert.ok(fs.existsSync(path.join(dir, 'managed/secrets.json')));
  const result = await service.login('example');
  assert.equal(result.status, 'filled'); assert.equal(result.authenticated, 'unverified');
  const visible = JSON.stringify([service.list(), result]);
  assert.equal(visible.includes('synthetic-password-only'), false);
  assert.equal(visible.includes('synthetic-user'), false);
  assert.equal(fs.statSync(path.join(dir, 'managed/secrets.json')).mode & 0o777, 0o600);
});
test('HTTP, lookalike domains, changed paths and redirects refuse before filling', async t => {
  const { service, browser, calls } = fixture(t);
  for (const url of ['http://login.example.test/signin', 'https://login.example.test.evil.test/signin', 'https://evil.test/signin', 'https://login.example.test/other']) {
    browser.currentUrl = async () => url;
    await assert.rejects(() => service.login('example'), /LOGIN_/);
  }
  assert.equal(calls(), 0);
});
test('site permission must be explicit and cancellation blocks secret dispatch', async t => {
  const { dir, profile, service, browser, calls } = fixture(t);
  saveSiteLogin(dir, 'disabled', { ...profile, allowAutoLogin: false });
  await assert.rejects(() => service.login('disabled'), /LOGIN_NOT_AUTHORIZED/);
  const controller = new AbortController();
  browser.currentUrl = async () => { controller.abort(); return profile.url; };
  await assert.rejects(() => service.login('example', true, controller.signal), /LOGIN_CANCELED/);
  assert.equal(calls(), 0);
});
test('submission is explicit and never reported as authenticated', async t => {
  const { service } = fixture(t);
  assert.equal((await service.login('example')).status, 'filled');
  const result = await service.login('example', true);
  assert.equal(result.status, 'submitted'); assert.equal(result.authenticated, 'unverified');
});
test('invalid identifiers and insecure profiles are rejected; malformed profile errors are redacted', async t => {
  const { dir, profile, service } = fixture(t);
  assert.throws(() => saveSiteLogin(dir, '../x', profile), /LOGIN_PROFILE_ID_INVALID/);
  assert.throws(() => saveSiteLogin(dir, 'bad', { ...profile, url: 'https://user:pass@example.test/' }), /LOGIN_REQUIRES/);
  assert.throws(() => saveSiteLogin(dir, 'bad', { ...profile, url: 'http://example.test/' }), /LOGIN_REQUIRES/);
  const file = path.join(dir, 'managed/secrets.json'), json = JSON.parse(fs.readFileSync(file));
  json.SITE_LOGIN_EXAMPLE.value = 'malformed synthetic-password-only'; fs.writeFileSync(file, JSON.stringify(json));
  await assert.rejects(() => service.login('example'), e => e.message === 'LOGIN_PROFILE_INVALID');
});
