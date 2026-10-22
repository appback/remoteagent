import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DotHostService } from '../dist/services/dot-host-service.js';
import { DotBridgeService } from '../dist/services/dot-bridge-service.js';
import { DotMcpService } from '../dist/services/dot-mcp-service.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-host-'));
  const root = path.join(dir, 'workspace'); fs.mkdirSync(root);
  const host = new DotHostService(dir, [root]);
  t.after(() => { host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const start = (command, extras = {}) => host.start('request-a', { operationId: 'op-1', command, cwd: root, ...extras });
  return { dir, root, host, start };
}
async function finished(host, id, request = 'request-a') {
  for (let i = 0; i < 150; i++) {
    const result = host.status(request, id);
    if (result.finishedAt) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('job did not finish');
}

test('real host execution returns bounded output and concrete exit status without a provider', async t => {
  const { host, start } = fixture(t);
  const job = start('printf hello; printf warning >&2; exit 7');
  assert.equal(job.status, 'running');
  const result = await finished(host, job.id);
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'hello'); assert.equal(result.stderr, 'warning');
  assert.equal(host.info().sandbox, false);
});

test('retries reuse operation IDs, conflicts fail, concurrency is bounded', async t => {
  const { host, start } = fixture(t);
  const first = start('sleep 10');
  assert.equal(start('sleep 10').id, first.id);
  assert.throws(() => start('printf duplicate'), /HOST_OPERATION_ID_CONFLICT/);
  const second = start('sleep 10', { operationId: 'op-2' });
  assert.throws(() => start('sleep 10', { operationId: 'op-3' }), /HOST_JOB_LIMIT/);
  assert.throws(() => host.status('other-request', first.id), /HOST_JOB_NOT_FOUND/);
  assert.throws(() => host.forget('request-a', first.id), /HOST_JOB_STILL_RUNNING/);
  host.cancel('request-a', first.id); host.cancel('request-a', second.id);
  assert.equal((await finished(host, first.id)).status, 'canceled');
  await finished(host, second.id);
  assert.equal(host.forget('request-a', first.id).removed, first.id);
});

test('timeout terminates the command; explicit request cancellation terminates its jobs', async t => {
  const { host, start } = fixture(t);
  const job = start('sleep 30', { timeoutSeconds: 1 });
  assert.equal((await finished(host, job.id)).status, 'timed_out');
  const other = start('sleep 30', { operationId: 'op-2' });
  host.cancelRequest('request-a');
  assert.equal((await finished(host, other.id)).status, 'canceled');
});

test('output truncation and minimal child environment', async t => {
  const { host, start } = fixture(t);
  process.env.DOT_HOST_TEST_SECRET = 'must-not-be-forwarded';
  t.after(() => { delete process.env.DOT_HOST_TEST_SECRET; });
  const env = start('printf "%s" "${DOT_HOST_TEST_SECRET-unset}"');
  assert.equal((await finished(host, env.id)).stdout, 'unset');
  const job = start('head -c 100000 /dev/zero', { operationId: 'op-2' });
  const result = await finished(host, job.id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 32768);
});

test('root containment, symlink escapes, binary and oversized files are rejected', t => {
  const { host, root, dir, start } = fixture(t);
  fs.writeFileSync(path.join(dir, 'outside'), 'private');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'escape'));
  for (const target of [path.join(dir, 'outside'), path.join(root, 'escape'), path.join(root, '..', 'outside')])
    assert.throws(() => host.fileOperation({ action: 'read', path: target }), /HOST_PATH_NOT_ALLOWED/);
  fs.symlinkSync(path.join(dir, 'missing'), path.join(root, 'dangling'));
  assert.throws(() => host.fileOperation({ action: 'write', path: path.join(root, 'dangling'), content: 'x', expectedSha256: null }), /HOST_PATH_NOT_ALLOWED/);
  assert.throws(() => start('pwd', { cwd: dir }), /HOST_PATH_NOT_ALLOWED/);
  assert.throws(() => start('pwd', { cwd: '.' }), /HOST_PATH_MUST_BE_ABSOLUTE/);
  const binary = path.join(root, 'binary'); fs.writeFileSync(binary, Buffer.from([255]));
  assert.throws(() => host.fileOperation({ action: 'read', path: binary }), /HOST_FILE_NOT_UTF8/);
  const large = path.join(root, 'large'); fs.writeFileSync(large, Buffer.alloc(32769));
  assert.throws(() => host.fileOperation({ action: 'read', path: large }), /HOST_FILE_TOO_LARGE/);
});

test('UTF-8 command output survives split multibyte pipe chunks', async t => {
  const { host, start } = fixture(t);
  const job = start("printf '\\354'; sleep 0.05; printf '\\225\\210'");
  assert.equal((await finished(host, job.id)).stdout, '\uC548');
});

test('file writes are atomic, preserve mode and reject stale expected hashes', t => {
  const { host, root } = fixture(t);
  const target = path.join(root, 'file.txt');
  const first = host.fileOperation({ action: 'write', path: target, content: 'first', expectedSha256: null });
  const read = host.fileOperation({ action: 'read', path: target });
  assert.equal(read.content, 'first'); assert.equal(read.sha256, first.sha256);
  assert.throws(() => host.fileOperation({ action: 'write', path: target, content: 'lost update', expectedSha256: null }), /HOST_FILE_CHANGED/);
  fs.chmodSync(target, 0o640);
  host.fileOperation({ action: 'write', path: target, content: 'second', expectedSha256: first.sha256 });
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(host.fileOperation({ action: 'list', path: root }).entries[0].name, 'file.txt');
});

test('restart marks running records interrupted and never replays commands', async t => {
  const { host, dir, root, start } = fixture(t);
  const job = start('sleep 30');
  const restored = new DotHostService(dir, [root]);
  t.after(() => restored.close());
  assert.equal(restored.status('request-a', job.id).status, 'interrupted');
  assert.equal(restored.start('request-a', { operationId: 'op-1', command: 'sleep 30', cwd: root }).id, job.id);
  assert.equal(fs.statSync(path.join(dir, 'dot', 'host-jobs.json')).mode & 0o777, 0o600);
  host.cancelRequest('request-a'); await finished(host, job.id);
  restored.close();
});

test('job persistence failure pauses new executions without crashing the event loop', async t => {
  const { host, dir, start } = fixture(t);
  const job = start('sleep 0.1; printf done');
  fs.unlinkSync(path.join(dir, 'dot', 'host-jobs.json'));
  fs.mkdirSync(path.join(dir, 'dot', 'host-jobs.json'));
  assert.equal((await finished(host, job.id)).stdout, 'done');
  assert.throws(() => start('pwd', { operationId: 'op-2' }), /HOST_EXECUTION_UNAVAILABLE/);
});

test('job history is bounded and new commands fail before spawning when full', t => {
  const { host, dir, root } = fixture(t);
  host.close();
  fs.writeFileSync(path.join(dir, 'dot', 'host-jobs.json'), JSON.stringify(Array.from({ length: 64 }, (_, i) => ({
    id: String(i), requestId: 'request-a', operationId: String(i), status: 'succeeded', stdout: '', stderr: ''
  }))));
  const restored = new DotHostService(dir, [root]);
  assert.throws(() => restored.start('request-a', { operationId: 'new', command: 'printf unexpected', cwd: root }), /HOST_JOB_HISTORY_FULL/);
  restored.close();
});

test('MCP host tools require OAuth, owner request binding and explicit enablement; stop cancels jobs', async t => {
  const { host, dir, root } = fixture(t);
  const bridge = new DotBridgeService(dir, 'owner', async (...args) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(args[4]).challenge }) }));
  const channelId = await bridge.connect('bot', 'chat');
  await bridge.subscribe('owner', { name: 'telegram.message.created', arguments: { channelId }, delivery: {
    mode: 'webhook', url: 'https://callback.example.test/', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') } });
  const requestId = await bridge.enqueue('bot', 'chat', '1', 'Perform host test');
  bridge.setHostCancellation(id => host.cancelRequest(id));
  const auth = async header => header === 'Bearer test' ? { subject: 'owner', expiresAt: Date.now() + 3600000 } : undefined;
  const mcp = new DotMcpService(bridge, '127.0.0.1', 0, { resource: 'https://host.example.test', issuer: 'https://auth.example.test' }, auth, undefined, host);
  const disabled = new DotMcpService(bridge, '127.0.0.1', 0, { resource: 'https://host.example.test', issuer: 'https://auth.example.test' }, auth);
  await mcp.start(); await disabled.start();
  t.after(async () => { bridge.close(); await mcp.close(); await disabled.close(); });
  const call = async (name, args, bearer = 'Bearer test', service = mcp) => {
    const response = await fetch(`http://127.0.0.1:${service.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: bearer },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? {} : { name, arguments: args } }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('dot_host_info', { requestId }, '')).status, 401);
  const hidden = await call('tools/list', {}, 'Bearer test', disabled);
  assert.equal(hidden.body.result.tools.some(x => x.name.startsWith('dot_host_')), false);
  const visible = await call('tools/list', {});
  assert.equal(visible.body.result.tools.filter(x => x.name.startsWith('dot_host_')).length, 6);
  assert.ok((await call('dot_host_info', { requestId: 'unknown' })).body.error);
  const started = await call('dot_host_exec', { requestId, operationId: 'test', command: 'sleep 30', cwd: root });
  const jobId = started.body.result.structuredContent.id;
  assert.ok(jobId);
  assert.ok((await call('dot_report', { requestId, reportId: 'premature', kind: 'result', text: 'done' })).body.error.message.startsWith('HOST_JOBS_STILL_RUNNING'));
  const malformed = await call('dot_host_job', { requestId, jobId, unexpected: 'x' });
  assert.ok(malformed.body.error);
  await bridge.cancel('bot', 'chat');
  assert.equal((await finished(host, jobId, requestId)).status, 'canceled');
  assert.ok((await call('dot_host_exec', { requestId, operationId: 'again', command: 'pwd', cwd: root })).body.error);
});
