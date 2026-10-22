import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DotWebatonService } from '../dist/services/dot-webaton-service.js';
import { DotMcpService } from '../dist/services/dot-mcp-service.js';
import { DotBridgeService } from '../dist/services/dot-bridge-service.js';
const accountId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-000000000002';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-webaton-'));
  const tokenFile = path.join(dir, 'mcp-token');
  fs.writeFileSync(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const calls = [];
  let state = 'running';
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : undefined;
    calls.push({ path: req.url, body, token: req.headers['x-agent-token'] });
    res.setHeader('content-type', 'application/json');
    const job = { id: jobId, accountId, mode: 'external', status: state, index: 1, note: '', events: [], files: [], challenge: { private: true } };
    if (req.url === '/api/accounts') return res.end(JSON.stringify([{ id: accountId, name: 'Test site', mode: 'session', password: 'NEVER_EXPOSE' }]));
    if (req.url === '/api/jobs' && req.method === 'POST') { state = 'running'; return res.end(JSON.stringify(job)); }
    if (req.url === '/api/jobs') return res.end(JSON.stringify([job, { id: 'unrelated', password: 'NEVER_EXPOSE' }]));
    if (req.url.endsWith('/observe')) return res.end(JSON.stringify({ title: 'Test page', controls: [{ selector: '#name', tag: 'input' }] }));
    if (req.url.endsWith('/finish')) { state = 'completed'; return res.end(JSON.stringify({ id: jobId, status: state })); }
    if (req.url.endsWith('/cancel')) { state = 'cancelled'; return res.end(JSON.stringify({ ...job, status: state })); }
    if (req.url.endsWith('/resume')) return res.end(JSON.stringify(job));
    if (req.url.endsWith('/action')) return res.end(JSON.stringify({ clicked: true }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const service = new DotWebatonService(dir, url, tokenFile);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const begin = (op = 'begin') => service.call('dot_webaton_begin', { requestId: 'request', operationId: op, accountId, instruction: 'Test browser' });
  const call = (name, args = {}) => service.call(`dot_webaton_${name}`, { requestId: 'request', jobId, ...args });
  return { dir, tokenFile, calls, url, service, begin, call };
}

test('existing Webaton external API is used without an extra LLM; credentials stay private', async t => {
  const f = await fixture(t);
  const accounts = await f.service.call('dot_webaton_accounts', { requestId: 'request' });
  assert.equal(accounts.accounts[0].id, accountId); assert.equal(JSON.stringify(accounts).includes('NEVER_EXPOSE'), false);
  const job = await f.begin(); assert.equal(job.mode, 'external'); assert.equal(job.id, jobId);
  assert.equal(f.calls.find(c => c.path === '/api/jobs').body.mode, 'external');
  assert.equal(JSON.stringify(job).includes('challenge'), false);
  assert.equal(f.calls.every(c => c.token === 'a'.repeat(64)), true);
  const observation = await f.call('observe'); assert.equal(observation.observation.title, 'Test page');
  assert.equal(observation.untrustedPageData, true);
  await f.call('act', { operationId: 'click', action: { type: 'click', selector: '#go' } });
  await f.call('finish', { operationId: 'finish' });
  assert.equal(f.service.hasActiveRequest('request'), false);
  assert.equal((await f.call('job')).status, 'completed');
});

test('begin/actions are idempotent; conflicting operation IDs and other requests are rejected', async t => {
  const f = await fixture(t); await f.begin(); await f.begin();
  assert.equal(f.calls.filter(c => c.path === '/api/jobs' && c.body).length, 1);
  const action = { operationId: 'click', action: { type: 'click', selector: '#go' } };
  await f.call('act', action); await f.call('act', action);
  assert.equal(f.calls.filter(c => c.path.endsWith('/action')).length, 1);
  await assert.rejects(() => f.call('act', { operationId: 'click', action: { type: 'click', selector: '#other' } }), /OPERATION_ID_CONFLICT/);
  await assert.rejects(() => f.call('observe', { requestId: 'other' }), /JOB_NOT_OWNED/);
  await assert.rejects(() => f.call('act', { operationId: 'bad', action: { type: 'evaluate', script: 'steal()' } }), /INVALID_WEBATON_ACTION/);
  await assert.rejects(() => f.call('act', { operationId: 'bad2', action: { type: 'navigate', url: 'file:///etc/passwd' } }), /INVALID_WEBATON_ACTION/);
});

test('transport ambiguity is never retried, including after adapter restart', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const failed = new DotWebatonService(f.dir, f.url, f.tokenFile, async () => { attempts++; throw Error('ECONNRESET'); });
  const args = { requestId: 'ambiguous', operationId: 'begin', accountId, instruction: 'Test' };
  await assert.rejects(() => failed.call('dot_webaton_begin', args), /WEBATON_CONNECTION_FAILED/);
  const restored = new DotWebatonService(f.dir, f.url, f.tokenFile, async () => { attempts++; throw Error('must not retry'); });
  await assert.rejects(() => restored.call('dot_webaton_begin', args), /WEBATON_OUTCOME_UNKNOWN/);
  assert.equal(attempts, 1);
  assert.equal(fs.statSync(path.join(f.dir, 'dot', 'webaton.json')).mode & 0o777, 0o600);
});

test('only loopback API and private local token files are accepted; token rotation is observed', async t => {
  const f = await fixture(t);
  for (const url of ['https://127.0.0.1:4380', 'http://localhost:4380', 'http://192.168.33.60:4380', f.url + '/api', 'http://user:pass@127.0.0.1:4380'])
    assert.throws(() => new DotWebatonService(f.dir, url, f.tokenFile), /WEBATON_CONFIGURATION_INVALID/);
  fs.chmodSync(f.tokenFile, 0o644);
  assert.throws(() => new DotWebatonService(f.dir, f.url, f.tokenFile), /WEBATON_TOKEN_FILE_NOT_PRIVATE/);
  fs.chmodSync(f.tokenFile, 0o600); fs.writeFileSync(f.tokenFile, 'b'.repeat(64));
  await f.service.call('dot_webaton_accounts', { requestId: 'request' });
  assert.equal(f.calls.at(-1).token, 'b'.repeat(64));
});

test('stop cancels only request-owned browser jobs; forgetting requires terminal state', async t => {
  const f = await fixture(t); await f.begin();
  await assert.rejects(() => f.call('forget'), /WEBATON_JOB_NOT_TERMINAL/);
  await f.service.cancelRequest('unrelated');
  assert.equal(f.calls.some(c => c.path.endsWith('/cancel')), false);
  await f.service.cancelRequest('request');
  assert.equal(f.service.hasActiveRequest('request'), false);
  assert.equal(f.calls.filter(c => c.path.endsWith('/cancel')).length, 1);
  await assert.rejects(() => f.begin('after-stop'), /WEBATON_REQUEST_CANCELED/);
  assert.equal((await f.call('forget')).removed, jobId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'dot', 'webaton.json'))).operations.length, 0);
});

test('MCP browser tools require owner OAuth and a request, and preserve disabled behavior', async t => {
  const f = await fixture(t);
  const bridge = new DotBridgeService(f.dir, 'owner', async () => ({ status: 204, body: '' }));
  await bridge.connect('bot', 'chat');
  // Supply a real stored Telegram request through the bridge's normal subscription flow.
  const channelId = bridge.channels('owner')[0].channelId;
  const realBridge = new DotBridgeService(f.dir, 'owner', async (...args) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(args[4]).challenge }) }));
  await realBridge.subscribe('owner', { name: 'telegram.message.created', arguments: { channelId }, delivery: { mode: 'webhook', url: 'https://example.test/events', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') } });
  const requestId = await realBridge.enqueue('bot', 'chat', '1', 'Browser test');
  let cancellation;
  realBridge.setHostCancellation(id => { cancellation = f.service.cancelRequest(id); });
  const auth = async h => h === 'Bearer owner' ? { subject: 'owner', expiresAt: Date.now() + 3600000 } : undefined;
  const mcp = new DotMcpService(realBridge, '127.0.0.1', 0, { resource: 'https://example.test', issuer: 'https://auth.example.test' }, auth, undefined, undefined, f.service);
  await mcp.start();
  t.after(async () => { realBridge.close(); bridge.close(); await mcp.close(); });
  const rpc = async (method, params = {}, token = 'Bearer owner') => {
    const r = await fetch(`http://127.0.0.1:${mcp.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await rpc('tools/list', {}, '')).status, 401);
  assert.equal((await rpc('tools/list')).body.result.tools.filter(t => t.name.startsWith('dot_webaton_')).length, 9);
  assert.ok((await rpc('tools/call', { name: 'dot_webaton_accounts', arguments: { requestId: 'unknown' } })).body.error);
  const result = await rpc('tools/call', { name: 'dot_webaton_begin', arguments: { requestId, operationId: 'start', accountId, instruction: 'Browser test' } });
  assert.equal(result.body.result.structuredContent.id, jobId);
  const premature = await rpc('tools/call', { name: 'dot_report', arguments: { requestId, reportId: 'bad', kind: 'result', text: 'done' } });
  assert.match(premature.body.error.message, /WEBATON_JOB_STILL_ACTIVE/);
  await realBridge.cancel('bot', 'chat');
  await cancellation;
  assert.equal(f.service.hasActiveRequest(requestId), false);
  assert.ok((await rpc('tools/call', { name: 'dot_webaton_observe', arguments: { requestId, jobId } })).body.error);
});
