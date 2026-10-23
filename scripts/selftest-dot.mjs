import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {DotBridgeService} from '../dist/services/dot-bridge-service.js';
import {DotMcpService, createDotAuthenticator} from '../dist/services/dot-mcp-service.js';
import {createDotWebhookPost, dotWebhookHeaders, isPublicDotAddress} from '../dist/services/dot-webhook.js';

const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const owner = 'test-owner';
const resource = 'https://bridge.example.test';
const issuer = 'https://identity.example.test';
async function fixture(t, postOverride) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remoteagent-dot-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  let now = Date.now(), verificationError;
  const deliveries = [], reports = [];
  const post = async (...args) => {
    const payload = JSON.parse(args[4]);
    deliveries.push({args, payload});
    if (payload.type === 'verification') {
      if (verificationError) throw verificationError;
      return {status: 200, body: JSON.stringify({challenge: payload.challenge})};
    }
    return postOverride ? postOverride(...args) : {status: 204, body: ''};
  };
  const bridge = new DotBridgeService(dir, owner, post, () => now);
  bridge.register('bot-a', async (chatId, text) => { reports.push({bot: 'a', chatId, text}); });
  bridge.register('bot-b', async (chatId, text) => { reports.push({bot: 'b', chatId, text}); });
  const channelId = await bridge.connect('bot-a', '123');
  const params = {name: 'telegram.message.created', arguments: {channelId},
    delivery: {mode: 'webhook', url: 'https://callback.example.test/events', secret}};
  const subscribe = () => bridge.subscribe(owner, params);
  const enqueue = async (update = '10', text = 'real user instruction') => {
    const id = await bridge.enqueue('bot-a', '123', update, text);
    await settle(); return id;
  };
  return {dir, bridge, deliveries, reports, channelId, params, subscribe, enqueue,
    advance(ms) { now += ms; }, post, failVerification(error) { verificationError = error; }};
}
async function settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }

test('Telegram attachments survive restart, preserve bytes and stay request/owner bound', async t => {
  const f = await fixture(t); await f.subscribe();
  const uploads = path.join(f.dir, 'uploads', 'telegram', 'bot-a', '123');
  await fs.mkdir(uploads, {recursive: true});
  const file = path.join(uploads, 'instruction.txt');
  const text = '첨부 문서입니다.\n'.repeat(25000);
  await fs.writeFile(file, text);
  const id = await f.bridge.enqueue('bot-a', '123', 'file-1', '문서를 검토해', [{path: file, name: 'instruction.txt', mimeType: 'text/plain'}]);
  await settle();
  const restarted = new DotBridgeService(f.dir, owner, f.post);
  const request = restarted.read(owner, id);
  assert.equal(request.text, '문서를 검토해');
  assert.equal(request.attachments.length, 1);
  assert.equal(JSON.stringify(request).includes(uploads), false);
  const attachmentId = request.attachments[0].attachmentId;
  const chunks = []; let offset = 0;
  for (;;) {
    const part = restarted.readAttachment(owner, id, attachmentId, offset);
    const bytes = Buffer.from(part.data, 'base64');
    assert.ok(bytes.length <= 192 * 1024);
    chunks.push(bytes); offset = part.nextOffset;
    if (part.eof) break;
  }
  assert.equal(Buffer.concat(chunks).toString('utf8'), text);
  assert.throws(() => restarted.readAttachment('other-owner', id, attachmentId));
  const other = await f.enqueue('other');
  assert.throws(() => f.bridge.readAttachment(owner, other, attachmentId), /DOT_ATTACHMENT_NOT_FOUND/);
  assert.throws(() => restarted.readAttachment(owner, id, attachmentId, -1), /DOT_ATTACHMENT_OFFSET/);
  await fs.writeFile(file, 'changed');
  assert.throws(() => restarted.readAttachment(owner, id, attachmentId), /DOT_ATTACHMENT_CHANGED/);
});

test('attachments reject outside paths and symlink escapes; missing/canceled files fail safely', async t => {
  const f = await fixture(t); await f.subscribe();
  const uploads = path.join(f.dir, 'uploads', 'telegram');
  await fs.mkdir(uploads, {recursive: true});
  const outside = path.join(f.dir, 'private.txt'); await fs.writeFile(outside, 'private');
  const link = path.join(uploads, 'link'); await fs.symlink(outside, link);
  for (const file of [outside, link]) {
    await assert.rejects(f.bridge.enqueue('bot-a', '123', file, 'read', [{path: file, name: 'test'}]), /DOT_ATTACHMENT_NOT_ALLOWED/);
  }
  const file = path.join(uploads, 'valid.txt'); await fs.writeFile(file, 'hello');
  const id = await f.bridge.enqueue('bot-a', '123', 'valid', 'read', [{path: file, name: 'valid.txt'}]);
  const aid = f.bridge.read(owner, id).attachments[0].attachmentId;
  assert.equal(f.bridge.readAttachment(owner, id, aid).text, 'hello');
  await fs.rm(file);
  assert.throws(() => f.bridge.readAttachment(owner, id, aid), /DOT_ATTACHMENT_UNAVAILABLE/);
  await f.bridge.cancel('bot-a', '123');
  assert.throws(() => f.bridge.readAttachment(owner, id, aid), /DOT_REQUEST_CLOSED/);
});

test('MCP exposes actual image content, text and bytes with authenticated attachment retrieval', async t => {
  const f = await fixture(t); await f.subscribe();
  const uploads = path.join(f.dir, 'uploads', 'telegram'); await fs.mkdir(uploads, {recursive: true});
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = path.join(uploads, 'image.png'); await fs.writeFile(image, png);
  const text = path.join(uploads, 'note.txt'); await fs.writeFile(text, '첨부 텍스트');
  const id = await f.bridge.enqueue('bot-a', '123', 'image', 'look', [{path: image, name: 'image.png'}, {path: text, name: 'note.txt'}]);
  const server = new DotMcpService(f.bridge, '127.0.0.1', 0, {resource, issuer}, async auth => auth === 'Bearer access' ? {subject: owner, expiresAt: Date.now() + 3600000} : undefined);
  await server.start(); t.after(() => server.close());
  const rpc = async (args, auth = 'Bearer access') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/mcp', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: auth},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'dot_read_attachment', arguments: args}})});
    return {status: response.status, body: await response.json()};
  };
  const [a, b] = f.bridge.read(owner, id).attachments;
  const result = await rpc({requestId: id, attachmentId: a.attachmentId, mode: 'image'});
  assert.equal(result.body.result.content[0].type, 'image');
  assert.equal(result.body.result.content[0].data, png.toString('base64'));
  const note = await rpc({requestId: id, attachmentId: b.attachmentId});
  assert.equal(note.body.result.structuredContent.text, '첨부 텍스트');
  assert.equal((await rpc({requestId: id, attachmentId: a.attachmentId}, '')).status, 401);
  assert.match((await rpc({requestId: id, attachmentId: b.attachmentId, mode: 'image'})).body.error.message, /DOT_IMAGE_FORMAT/);
  assert.match((await rpc({requestId: id, attachmentId: a.attachmentId, path: '/etc/passwd'})).body.error.message, /INVALID_TOOL_ARGUMENTS/);
});

test('webhook signatures cover exact bytes, event ID and timestamp', () => {
  const body = JSON.stringify({text: 'test'});
  const headers = dotWebhookHeaders(secret, 'subscription', 'event', body, 100);
  const expected = createHmac('sha256', Buffer.alloc(32, 7)).update(`event.100.${body}`).digest('base64');
  assert.equal(headers['webhook-signature'], 'v1,' + expected);
  assert.equal(headers['webhook-id'], 'event');
  assert.throws(() => dotWebhookHeaders('whsec_YQ==', 's', 'e', body), /INVALID_SIGNING_SECRET/);
});

test('callback transport rejects private, mapped, special addresses and non-allowlisted URLs', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '192.168.33.30',
    '198.18.1.2', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::']) {
    assert.equal(isPublicDotAddress(address), false, address);
  }
  assert.equal(isPublicDotAddress('8.8.8.8'), true);
  assert.equal(isPublicDotAddress('2606:4700:4700::1111'), true);
  const send = createDotWebhookPost(['127.0.0.1', 'callback.example.test']);
  for (const url of ['http://callback.example.test/', 'https://other.test/', 'https://user:pass@callback.example.test/',
    'https://callback.example.test:444/', 'https://callback.example.test/#fragment', 'https://127.0.0.1/']) {
    await assert.rejects(() => send(url, secret, 's', 'e', '{}'), /CALLBACK_/);
  }
});

test('public HTTPS delivery pins DNS, preserves hostname and does not follow redirects', async () => {
  let resolutions = 0, connections = 0;
  const send = createDotWebhookPost(['callback.example.test'], async () => {
    resolutions++; return [{address: '8.8.8.8', family: 4}];
  }, (url, options, onResponse) => {
    connections++; assert.equal(url.hostname, 'callback.example.test');
    assert.equal(options.family, 4); assert.equal(options.autoSelectFamily, false);
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
    });
    assert.equal(options.headers['webhook-signature'].split(' ').length, 2);
    const request = new EventEmitter();
    request.end = body => {
      assert.equal(body, '{}');
      const response = new EventEmitter();
      response.statusCode = 302; response.headers = {location: 'https://127.0.0.1/'};
      onResponse(response);
      queueMicrotask(() => { response.emit('end'); request.emit('close'); });
    };
    request.destroy = error => { request.emit('error', error); request.emit('close'); };
    return request;
  });
  const result = await send('https://callback.example.test/path', secret, 'sub', 'event', '{}',
    'whsec_' + Buffer.alloc(32, 8).toString('base64'));
  assert.equal(result.status, 302); assert.equal(resolutions, 1); assert.equal(connections, 1);
});

test('callback deadline also bounds DNS resolution without opening a connection', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let connections = 0;
  const send = createDotWebhookPost(['callback.example.test'], () => new Promise(() => {}),
    () => { connections++; throw Error('must not connect'); });
  const rejected = assert.rejects(() => send('https://callback.example.test/', secret, 's', 'e', '{}'), /CALLBACK_TIMEOUT/);
  t.mock.timers.tick(10000);
  await rejected; assert.equal(connections, 0);
});

test('connect is explicit and idempotent, subscriptions require valid ownership and callback proof', async t => {
  const f = await fixture(t);
  assert.equal(await f.bridge.connect('bot-a', '123'), f.channelId);
  assert.deepEqual(f.bridge.channels('other'), []);
  await assert.rejects(() => f.enqueue(), /DOT_NOT_SUBSCRIBED/);
  await assert.rejects(() => f.bridge.subscribe('other', f.params), /INVALID_SUBSCRIPTION/);
  await assert.rejects(() => f.bridge.subscribe(owner, {...f.params, ttlMs: -1}), /INVALID_TTL/);
  await assert.rejects(() => f.bridge.subscribe(owner, {...f.params, delivery: {...f.params.delivery, secret: 'bad'}}), /INVALID_SIGNING_SECRET/);
  const sub = await f.subscribe();
  assert.equal(f.deliveries[0].payload.type, 'verification');
  const refresh = await f.subscribe();
  assert.equal(refresh.id, sub.id);
  assert.equal(f.deliveries.length, 1, 'unchanged verified callback must not be re-challenged on each refresh');
  await assert.rejects(() => f.bridge.subscribe(owner, {...f.params, delivery: {...f.params.delivery, url: 'https://different.test/'}}), /ALREADY_SUBSCRIBED/);
  const bad = new DotBridgeService(path.join(f.dir, 'bad'), owner, async () => ({status: 200, body: '{"challenge":"wrong"}'}));
  const channelId = await bad.connect('bot', '1');
  await assert.rejects(() => bad.subscribe(owner, {...f.params, arguments: {channelId}}), /CALLBACK_VERIFICATION_FAILED/);
});

test('event acknowledgement is not completion; full read and reports use saved destination and deduplicate', async t => {
  const f = await fixture(t); await f.subscribe();
  const text = 'a'.repeat(5000), id = await f.enqueue('10', text);
  assert.equal(await f.enqueue('10', text), id);
  assert.equal(f.deliveries.filter(d => d.payload.eventId === id).length, 1);
  assert.equal(f.bridge.read(owner, id).status, 'accepted');
  assert.equal(f.bridge.read(owner, id).text, text);
  assert.equal(f.deliveries.at(-1).payload.data.text.length, 1000);
  assert.throws(() => f.bridge.read('other', id), /NOT_FOUND/);
  const args = {requestId: id, reportId: 'part1', kind: 'progress', text: 'Performed step one.'};
  await Promise.all([f.bridge.report(owner, args), f.bridge.report(owner, args)]);
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].bot, 'a'); assert.equal(f.reports[0].chatId, '123');
  assert.equal(f.bridge.read(owner, id).status, 'accepted');
  await assert.rejects(() => f.bridge.report(owner, {...args, text: 'different'}), /REPORT_ID_CONFLICT/);
  await assert.rejects(() => f.bridge.report(owner, {...args, reportId: 'bad', chatId: 'attacker'}), /INVALID_REPORT/);
  await f.bridge.report(owner, {...args, reportId: 'final', kind: 'result', text: 'Completed requested work.'});
  assert.equal(f.bridge.read(owner, id).status, 'completed');
  await assert.rejects(() => f.bridge.report(owner, {...args, reportId: 'extra'}), /REQUEST_CLOSED/);
});

test('bounded retries reuse event ID, observe retry-after and do not retry 410 or 413', async t => {
  for (const status of [429, 503, 410, 413]) {
    const f = await fixture(t, async () => ({status, body: '', retryAfterMs: 120000}));
    await f.subscribe(); const id = await f.enqueue();
    const expectedAttempts = [410, 413].includes(status) ? 1 : 3;
    await f.bridge.pump();
    assert.equal(f.deliveries.filter(d => d.payload.eventId === id).length, 1);
    for (let i = 0; i < 4; i++) { f.advance(120001); await f.bridge.pump(); }
    assert.equal(f.deliveries.filter(d => d.payload.eventId === id).length, expectedAttempts);
    assert.equal(f.bridge.read(owner, id).status, 'failed');
  }
});

test('network failure has bounded retry and expired subscriptions fail closed', async t => {
  const f = await fixture(t, async () => { throw Error('network failure'); });
  await f.subscribe(); const id = await f.enqueue();
  for (let i = 0; i < 4; i++) { f.advance(120001); await f.bridge.pump(); }
  assert.equal(f.deliveries.filter(d => d.payload.eventId === id).length, 3);
  f.advance(86400001);
  await assert.rejects(() => f.enqueue('11'), /DOT_NOT_SUBSCRIBED/);
});

test('stop and unsubscribe also close failed/ambiguous webhook requests before delayed cloud replies', async t => {
  for (const operation of ['stop', 'unsubscribe']) {
    const f = await fixture(t, async () => ({status: 413, body: ''}));
    await f.subscribe(); const id = await f.enqueue();
    assert.equal(f.bridge.read(owner, id).status, 'failed');
    if (operation === 'stop') assert.equal(await f.bridge.cancel('bot-a', '123'), 1);
    else await f.bridge.unsubscribe(owner, f.params);
    await assert.rejects(() => f.bridge.report(owner, {requestId: id, reportId: 'late', kind: 'result', text: 'Delayed answer'}), /DOT_REQUEST_CLOSED/);
    assert.equal(f.reports.length, 0);
  }
});

test('stop/off and unsubscribe block delayed replies without restarting local providers', async t => {
  const f = await fixture(t); await f.subscribe();
  const id = await f.enqueue();
  assert.equal(await f.bridge.cancel('bot-a', '123'), 1);
  await assert.rejects(() => f.bridge.report(owner, {requestId: id, reportId: 'late', kind: 'result', text: 'Late'}), /CLOSED/);
  const id2 = await f.enqueue('11');
  await f.bridge.unsubscribe(owner, f.params); await f.bridge.unsubscribe(owner, f.params);
  assert.equal(f.bridge.read(owner, id2).status, 'canceled');
  await f.subscribe(); const id3 = await f.enqueue('12');
  await f.bridge.disconnect('bot-a', '123');
  assert.equal(f.bridge.isBound('bot-a', '123'), false);
  await assert.rejects(() => f.bridge.report(owner, {requestId: id3, reportId: 'late', kind: 'result', text: 'Late'}), /NOT_FOUND/);
  assert.equal(f.reports.length, 0);
});

test('configuration failure preserves paused dot bindings rather than falling back to local work', async t => {
  const f = await fixture(t); await f.subscribe();
  const restored = new DotBridgeService(f.dir, owner, f.post);
  restored.pause();
  assert.equal(restored.isBound('bot-a', '123'), true);
  await assert.rejects(() => restored.enqueue('bot-a', '123', '1', 'must not run locally'), /CONFIGURATION_UNAVAILABLE/);
  await assert.rejects(() => restored.connect('bot-a', '123'), /CONFIGURATION_UNAVAILABLE/);
  await restored.disconnect('bot-a', '123');
  assert.equal(restored.isBound('bot-a', '123'), false);
});

test('login preparation preserves local routing; verified start and provider switching reuse the subscription', async t => {
  const f = await fixture(t);
  const channelId = await f.bridge.prepare('bot-b', '456');
  assert.equal(await f.bridge.prepare('bot-b', '456'), channelId);
  assert.equal(f.bridge.isBound('bot-b', '456'), false);
  await assert.rejects(() => f.bridge.activate('bot-b', '456'), /DOT_NOT_SUBSCRIBED/);
  const params = {...f.params, arguments: {channelId}};
  await f.bridge.subscribe(owner, params);
  assert.equal(f.bridge.isBound('bot-b', '456'), false);
  await assert.rejects(() => f.bridge.enqueue('bot-b', '456', '1', 'too early'), /DOT_NOT_STARTED/);
  await f.bridge.activate('bot-b', '456');
  const id = await f.bridge.enqueue('bot-b', '456', '2', 'task'); await settle();
  await f.bridge.suspend('bot-b', '456');
  assert.equal(f.bridge.read(owner, id).status, 'canceled');
  assert.equal(f.bridge.connection('bot-b', '456').subscribed, true);
  assert.equal(f.bridge.isBound('bot-b', '456'), false);
  assert.equal(await f.bridge.activate('bot-b', '456'), channelId);
});

test('disk write failure pauses future work before any unpersisted instruction can be sent', async t => {
  const f = await fixture(t); await f.subscribe();
  const stateFile = path.join(f.dir, 'dot/bridge.json');
  await fs.rename(stateFile, stateFile + '.before-test');
  await fs.mkdir(stateFile);
  await assert.rejects(() => f.enqueue(), /DOT_STORAGE_FAILED/);
  await assert.rejects(() => f.enqueue('11'), /DOT_STORAGE_FAILED/);
  assert.match(f.bridge.status('bot-a', '123'), /state storage failed/);
  assert.equal(f.deliveries.filter(d => d.payload.name === 'telegram.message.created').length, 0);
});

test('restart resumes an interrupted webhook with its original event ID and bounded attempts', async t => {
  const f = await fixture(t, async () => ({status: 503, body: ''}));
  await f.subscribe(); const id = await f.enqueue();
  const stateFile = path.join(f.dir, 'dot/bridge.json');
  const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  stored.messages[0].status = 'sending'; stored.messages[0].nextAttempt = 0;
  await fs.writeFile(stateFile, JSON.stringify(stored));
  const restored = new DotBridgeService(f.dir, owner, f.post);
  await restored.pump();
  assert.equal(f.deliveries.filter(d => d.payload.eventId === id).length, 2);
  assert.equal(restored.read(owner, id).status, 'pending');
});

test('signing secret rotation verifies the new key and uses a bounded two-key overlap', async t => {
  const f = await fixture(t); await f.subscribe();
  const next = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
  await f.bridge.subscribe(owner, {...f.params, delivery: {...f.params.delivery, secret: next}});
  assert.equal(f.deliveries.filter(d => d.payload.type === 'verification').length, 2);
  await f.enqueue();
  assert.equal(f.deliveries.at(-1).args[1], next); assert.equal(f.deliveries.at(-1).args[5], secret);
  f.advance(300001); await f.enqueue('11');
  assert.equal(f.deliveries.at(-1).args[5], undefined);
});

test('ambiguous Telegram delivery is never automatically resent, including after restart', async t => {
  const f = await fixture(t); await f.subscribe(); const id = await f.enqueue(); let calls = 0;
  f.bridge.register('bot-a', async () => { calls++; throw Error('connection reset after write'); });
  const report = {requestId: id, reportId: 'r1', kind: 'result', text: 'Answer'};
  await assert.rejects(() => f.bridge.report(owner, report), /DELIVERY_UNKNOWN/);
  assert.equal((await f.bridge.report(owner, report)).status, 'unknown');
  await assert.rejects(() => f.bridge.report(owner, {...report, reportId: 'r2'}), /DELIVERY_UNKNOWN/);
  const restored = new DotBridgeService(f.dir, owner, f.post);
  restored.register('bot-a', async () => { calls++; });
  assert.equal((await restored.report(owner, report)).status, 'unknown'); assert.equal(calls, 1);
  const filename = path.join(f.dir, 'dot/bridge.json');
  const stored = JSON.parse(await fs.readFile(filename, 'utf8'));
  stored.messages[0].reports[0].status = 'sending';
  await fs.writeFile(filename, JSON.stringify(stored));
  const interrupted = new DotBridgeService(f.dir, owner, f.post);
  assert.equal((await interrupted.report(owner, report)).status, 'unknown');
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});

test('OAuth introspection enforces active owner, audience, lifetime and scope on each request', async () => {
  const config = {resource, issuer, introspectionUrl: issuer + '/introspect', clientId: 'bridge', clientSecret: 'hidden', subject: owner};
  const good = {active: true, sub: owner, aud: resource, iss: issuer, exp: Date.now() / 1000 + 3600, scope: 'remoteagent:dot'};
  let data = good, calls = 0;
  const auth = createDotAuthenticator(config, async (url, init) => {
    calls++; assert.equal(url, config.introspectionUrl); assert.equal(init.redirect, 'error');
    assert.match(init.headers.authorization, /^Basic /); assert.match(String(init.body), /token=access/);
    return Response.json(data);
  });
  assert.equal(await auth(undefined), undefined);
  assert.deepEqual(await auth('Bearer access'), {subject: owner, expiresAt: good.exp * 1000});
  for (const patch of [{active: false}, {sub: 'other'}, {aud: 'other'}, {iss: 'other'}, {exp: 1}, {scope: 'other'}, {nbf: Date.now() / 1000 + 500}]) {
    data = {...good, ...patch}; assert.equal(await auth('Bearer access'), undefined);
  }
  assert.equal(calls, 8);
  assert.throws(() => createDotAuthenticator({...config, resource: 'http://unsafe.test'}), /HTTPS/);
});

test('access is rechecked before event delivery; revoked tokens never receive user text', async t => {
  const f = await fixture(t);
  let allowed = true;
  const bridge = new DotBridgeService(path.join(f.dir, 'revocation'), owner, f.post, Date.now,
    async header => allowed && header === 'Bearer active' ? owner : undefined);
  const channelId = await bridge.connect('bot-a', '123');
  await bridge.subscribe(owner, {...f.params, arguments: {channelId}}, 'Bearer active');
  allowed = false;
  const id = await bridge.enqueue('bot-a', '123', '1', 'private instruction'); await settle();
  assert.equal(bridge.read(owner, id).status, 'failed');
  assert.equal(f.deliveries.filter(d => d.payload.eventId === id).length, 0);
});

test('MCP HTTP discovery, OAuth challenge, tools and signed event/report round trip', async t => {
  const f = await fixture(t);
  const expiresAt = Date.now() + 3600000;
  const server = new DotMcpService(f.bridge, '127.0.0.1', 0, {resource, issuer}, async header => header === 'Bearer access' ? {subject: owner, expiresAt} : undefined);
  await server.start(); t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const rpc = async (method, params = {}, options = {}) => {
    const response = await fetch(url + '/mcp', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer access', ...options.headers},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
    return {response, body: await response.json()};
  };
  const challenge = await fetch(url + '/mcp', {method: 'POST'});
  assert.equal(challenge.status, 401); assert.match(challenge.headers.get('www-authenticate'), /oauth-protected-resource/);
  const metadata = await (await fetch(url + '/.well-known/oauth-protected-resource')).json();
  assert.equal(metadata.resource, resource); assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.equal((await rpc('server/discover')).body.result.supportedVersions[0], '2026-07-28');
  assert.equal((await rpc('initialize')).body.result.protocolVersion, '2026-07-28');
  assert.equal((await rpc('events/list')).body.result.events[0].name, 'telegram.message.created');
  assert.equal((await rpc('tools/list')).body.result.tools.length, 4);
  const sub = (await rpc('events/subscribe', f.params)).body.result;
  assert.ok(sub.id);
  assert.ok(Date.parse(sub.refreshBefore) <= expiresAt - 60000, 'subscription refresh must precede OAuth expiry');
  const id = await f.enqueue();
  const read = (await rpc('tools/call', {name: 'dot_read_request', arguments: {requestId: id}})).body.result;
  assert.equal(read.structuredContent.text, 'real user instruction');
  const result = (await rpc('tools/call', {name: 'dot_report', arguments: {requestId: id, reportId: 'final', kind: 'result', text: 'Test result'}})).body.result;
  assert.equal(result.structuredContent.status, 'sent'); assert.equal(f.reports[0].chatId, '123');
  assert.equal((await rpc('unrecognized')).body.error.code, -32601);
  f.failVerification(Error('private-network-error-with-sensitive-details'));
  const badCallback = (await rpc('events/subscribe', {...f.params,
    delivery: {...f.params.delivery, secret: 'whsec_' + Buffer.alloc(32, 8).toString('base64')}})).body;
  assert.equal(badCallback.error.code, -32015);
  assert.equal(badCallback.error.data.reason, 'callback_verification_failed');
  assert.equal(JSON.stringify(badCallback).includes('sensitive-details'), false);
  assert.equal((await rpc('ping', {}, {headers: {origin: 'https://evil.test'}})).response.status, 403);
  const bad = await fetch(url + '/mcp', {method: 'POST', headers: {authorization: 'Bearer access', 'content-type': 'application/json'}, body: 'not json'});
  assert.equal(bad.status, 400);
  assert.equal((await rpc('events/unsubscribe', f.params)).body.result.constructor, Object);
});
