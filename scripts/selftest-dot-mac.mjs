import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DotMacService, validateAutofillPoint } from '../dist/services/dot-mac-service.js';
import { DotBridgeService } from '../dist/services/dot-bridge-service.js';
import { DotMcpService } from '../dist/services/dot-mcp-service.js';
import { DotLoginService, saveSiteLogin } from '../dist/services/dot-login-service.js';

const script = path.resolve('scripts/selftest-dot-mac-backend.mjs');
test('Apple AutoFill requires an observed bounded native target instead of guessing shortcuts or menus', () => {
  validateAutofillPoint('915,326'); validateAutofillPoint('-300,20');
  for (const p of [undefined, '', '1,2,3', 'NaN,0', '40000,0', 'Edit > AutoFill'])
    assert.throws(() => validateAutofillPoint(p), /MAC_AUTOFILL_TARGET_REQUIRED/);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-mac-'));
  const service = new DotMacService(dir, process.execPath, undefined, true, [script]);
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (tool, args = {}) => service.call(`dot_mac_${tool}`, { requestId: 'request', ...args });
  return { service, call, dir };
}
test('native tool schemas are reused, namespace/owner fields added, AI and shell tools excluded', async t => {
  const { service } = fixture(t);
  const [first, second] = await Promise.all([service.definitions(), service.definitions()]);
  assert.equal(first.length, second.length);
  assert.ok(first.some(t => t.name === 'dot_mac_see'));
  assert.ok(first.some(t => t.name === 'dot_mac_click'));
  assert.ok(!first.some(t => /agent|analyze|shell/.test(t.name)));
  const click = first.find(t => t.name === 'dot_mac_click');
  assert.ok(click.inputSchema.required.includes('operationId'));
  assert.ok(click.inputSchema.required.includes('requestId'));
  assert.equal(first.find(t => t.name === 'dot_mac_see').inputSchema.properties.path, undefined);
});
test('Apple Passwords opens through native UI with no vault reads, fallback copy or repeated launch', async t => {
  const { call, service, dir } = fixture(t);
  const input = { operationId: 'passwords-open', action: 'passwords' };
  const result = await call('autofill', input);
  assert.deepEqual(await call('autofill', input), result);
  assert.ok(result.content.some(c => c.type === 'text' && c.text.includes('Authentication is unverified')));
  assert.equal(fs.existsSync(path.join(dir, 'managed/secrets.json')), false);
  service.cancelRequest('request');
  await assert.rejects(() => call('autofill', { ...input, operationId: 'after-stop' }), /MAC_REQUEST_CANCELED/);
});
test('Safari AutoFill clicks only its explicitly observed login/key target and preserves UI-only status', async t => {
  const { call, service, dir } = fixture(t);
  await assert.rejects(() => call('autofill', { operationId: 'no-point', action: 'safari' }), /MAC_AUTOFILL_TARGET_REQUIRED/);
  const result = await call('autofill', { operationId: 'safari-passwords', action: 'safari', coords: '915,326' });
  const native = JSON.parse(result.content[0].text);
  assert.equal(native.coords, '915,326');
  assert.equal(native.count, 1);
  assert.ok(result.content.some(c => c.type === 'text' && c.text.includes('Authentication is unverified')));
  assert.equal((await service.definitions()).some(t => t.name === 'dot_mac_menu'), false);
  assert.equal(fs.existsSync(path.join(dir, 'managed/secrets.json')), false);
});
test('screenshots remain native image blocks and snapshot/AX metadata reaches the caller', async t => {
  const { call } = fixture(t);
  const result = await call('see', { app_target: 'Safari' });
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].mimeType, 'image/png');
  assert.ok(result.content.some(c => c.type === 'text' && c.text.includes('snapshot-test')));
  assert.equal((await call('image')).content[0].type, 'image');
});
test('mutations deduplicate on retries and survive service restart without repeated input', async t => {
  const { service, call, dir } = fixture(t);
  const input = { operationId: 'click-1', on: 'button', snapshot: 'snapshot-test' };
  const a = await call('click', input), b = await call('click', input);
  assert.deepEqual(a, b);
  await assert.rejects(() => call('click', { ...input, on: 'other' }), /MAC_OPERATION_ID_CONFLICT/);
  await service.close();
  const restored = new DotMacService(dir, process.execPath, undefined, true, [script]);
  try { assert.deepEqual(await restored.call('dot_mac_click', { requestId: 'request', ...input }), a); }
  finally { await restored.close(); }
  assert.equal(fs.statSync(path.join(dir, 'dot', 'mac-operations.json')).mode & 0o777, 0o600);
});
test('lost transport leaves an unknown receipt and never replays that input', async t => {
  const { call } = fixture(t);
  const input = { operationId: 'lost', text: 'disconnect', snapshot: 'snapshot-test' };
  await assert.rejects(() => call('type', input), /MAC_CALL_INTERRUPTED/);
  await assert.rejects(() => call('type', input), /MAC_OUTCOME_UNKNOWN/);
});
test('dispatched input is not mislabeled a transport failure or automatically repeated', async t => {
  const { call } = fixture(t);
  const args = { operationId: 'unverified', text: 'unverified' };
  const result = await call('type', args);
  assert.equal(result.isError, false);
  assert.equal(result._meta.state, 'dispatched_unverified');
  assert.ok(result.content.some(c => c.type === 'text' && c.text.includes('Do not resend')));
  assert.deepEqual(await call('type', args), result);
});
test('cancel blocks queued/new input and does not quit target applications', async t => {
  const { service, call } = fixture(t);
  const pending = call('type', { operationId: 'slow', text: 'slow', snapshot: 'snapshot-test' });
  const rejection = assert.rejects(() => pending, /MAC_CALL_INTERRUPTED|MAC_REQUEST_CANCELED/);
  for (let i = 0; i < 100 && !service.hasActiveRequest('request'); i++) await new Promise(r => setTimeout(r, 10));
  service.cancelRequest('request'); await rejection;
  await assert.rejects(() => call('click', { operationId: 'later', on: 'x' }), /MAC_REQUEST_CANCELED/);
});
test('no API credentials are inherited and bulk quit / arbitrary fields are rejected', async t => {
  const { call } = fixture(t);
  process.env.OPENAI_API_KEY = 'never-inherit-this';
  try {
    const result = await call('app', { operationId: 'list', action: 'list' });
    assert.equal(JSON.stringify(result).includes('never-inherit-this'), false);
    assert.equal(JSON.parse(result.content[0].text).secretsInherited, false);
    await assert.rejects(() => call('app', { operationId: 'quit', action: 'quit' }), /MAC_APP_ACTION_NOT_ALLOWED/);
    await assert.rejects(() => call('app', { operationId: 'quit2', action: 'list', all: true }), /INVALID_MAC_ARGUMENTS/);
  } finally { delete process.env.OPENAI_API_KEY; }
});
test('permissions are reported as missing, not bypassed or claimed ready', async t => {
  const { call } = fixture(t);
  const result = await call('status');
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.ready, false);
  assert.equal(status.permissions[0].isGranted, false);
});
test('stored login uses private profile values and idempotent receipts, never password tool arguments', async t => {
  const { service, dir } = fixture(t); await service.close();
  saveSiteLogin(dir, 'test', { url: 'https://login.example.test/', username: 'private-account', password: 'private-password', allowAutoLogin: true });
  let fills = 0;
  const login = new DotLoginService(dir, { currentUrl: async () => 'https://login.example.test/', fill: async () => { fills++; return 'submitted'; } });
  const mac = new DotMacService(dir, process.execPath, undefined, true, [script], undefined, login);
  try {
    const args = { requestId: 'r', operationId: 'sign-in', profileId: 'test', submit: true };
    const result = await mac.call('dot_mac_login', args);
    assert.deepEqual(await mac.call('dot_mac_login', args), result);
    assert.equal(fills, 1);
    const visible = JSON.stringify([result, await mac.call('dot_mac_login_profiles', { requestId: 'r' })])
      + fs.readFileSync(path.join(dir, 'dot/mac-operations.json'), 'utf8');
    assert.equal(visible.includes('private-password'), false); assert.equal(visible.includes('private-account'), false);
    await assert.rejects(() => mac.call('dot_mac_login', { ...args, operationId: 'bad', password: 'never-allowed' }), /INVALID_MAC_ARGUMENTS/);
  } finally { await mac.close(); }
});
test('native GUI capture replaces only screen tools without requiring the input engine screen grant', async t => {
  const { service, dir } = fixture(t); await service.close();
  const screen = { verified: false, async capture() { this.verified = true; return { content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] }; } };
  const native = new DotMacService(dir, process.execPath, undefined, true, [script], screen);
  try {
    const defs = await native.definitions();
    assert.equal(defs.some(t => t.name === 'dot_mac_see'), false);
    assert.equal(defs.some(t => t.name.startsWith('dot_webaton_')), false);
    assert.ok(defs.some(t => t.name === 'dot_mac_click'));
    assert.equal(JSON.parse((await native.call('dot_mac_status', { requestId: 'r' })).content[0].text).screenVerificationRequired, true);
    const result = await native.call('dot_mac_image', { requestId: 'r' });
    assert.equal(result.content[0].type, 'image');
    const status = JSON.parse((await native.call('dot_mac_status', { requestId: 'r' })).content[0].text);
    assert.equal(status.ready, true);
    assert.equal(status.screenVerificationRequired, false);
  } finally { await native.close(); }
});
test('MCP authenticates native UI calls, preserves image blocks and rejects canceled requests', async t => {
  const { service, dir } = fixture(t);
  const bridge = new DotBridgeService(dir, 'owner', async (...args) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(args[4]).challenge }) }));
  const channelId = await bridge.connect('bot', 'chat');
  await bridge.subscribe('owner', { name: 'telegram.message.created', arguments: { channelId }, delivery: {
    mode: 'webhook', url: 'https://callback.example.test/', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') } });
  const requestId = await bridge.enqueue('bot', 'chat', '1', 'Inspect Safari');
  bridge.setHostCancellation(id => service.cancelRequest(id));
  const mcp = new DotMcpService(bridge, '127.0.0.1', 0,
    { resource: 'https://mac.example.test', issuer: 'https://auth.example.test' },
    async header => header === 'Bearer test' ? { subject: 'owner', expiresAt: Date.now() + 3600000 } : undefined,
    undefined, undefined, service);
  await mcp.start();
  t.after(async () => { bridge.close(); await mcp.close(); });
  const call = async (name, args, bearer = 'Bearer test') => {
    const response = await fetch(`http://127.0.0.1:${mcp.address().port}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('dot_mac_see', { requestId }, '')).status, 401);
  assert.ok((await call('dot_mac_see', { requestId: 'unknown' })).body.error);
  const image = await call('dot_mac_see', { requestId, app_target: 'Safari' });
  assert.equal(image.body.result.content[0].type, 'image');
  assert.equal(image.body.result.content[0].mimeType, 'image/png');
  await bridge.cancel('bot', 'chat');
  assert.ok((await call('dot_mac_click', { requestId, operationId: 'after-stop', on: 'button' })).body.error);
});
