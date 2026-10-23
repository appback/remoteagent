import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DotMacService } from '../dist/services/dot-mac-service.js';
import { DotMacScreenService } from '../dist/services/dot-mac-screen-service.js';
import { DotHostService } from '../dist/services/dot-host-service.js';
import { DotBridgeService } from '../dist/services/dot-bridge-service.js';
import { DotMcpService } from '../dist/services/dot-mcp-service.js';

if (process.platform !== 'darwin') throw Error('Actual Mac required');
const dir = fs.mkdtempSync('/private/tmp/dot-mcp-acceptance-');
const root = process.env.HOME + '/.local/lib/node_modules/appback-remoteagent';
const mac = new DotMacService(dir, process.env.HOME + '/.local/bin/peekaboo',
  process.env.HOME + '/Library/Application Support/Peekaboo/daemon.sock', true, [], new DotMacScreenService());
const host = new DotHostService(dir, [root]);
// Isolated transport/auth fixture; never registers with or reports to production dot.
const bridge = new DotBridgeService(dir, 'test-owner', async (...args) => ({ status: 200,
  body: JSON.stringify({ challenge: JSON.parse(args[4]).challenge }) }));
const mcp = new DotMcpService(bridge, '127.0.0.1', 0,
  { resource: 'https://acceptance.example.test', issuer: 'https://auth.example.test' },
  async h => h === 'Bearer isolated-test' ? { subject: 'test-owner', expiresAt: Date.now() + 3600000 } : undefined,
  undefined, host, mac);
try {
  const channelId = await bridge.connect('isolated-test-bot', 'isolated-test-chat');
  await bridge.subscribe('test-owner', { name: 'telegram.message.created', arguments: { channelId }, delivery: {
    mode: 'webhook', url: 'https://callback.example.test/', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') } });
  const requestId = await bridge.enqueue('isolated-test-bot', 'isolated-test-chat', 'test', 'Read-only acceptance');
  await mcp.start();
  const rpc = async (method, params = {}, auth = 'Bearer isolated-test') => {
    const r = await fetch(`http://127.0.0.1:${mcp.address().port}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await rpc('tools/list', {}, '')).status, 401);
  const tools = (await rpc('tools/list')).body.result.tools;
  assert.ok(tools.some(t => t.name === 'dot_mac_image'));
  assert.equal(tools.some(t => t.name.startsWith('dot_webaton_')), false);
  const code = (await rpc('tools/call', { name: 'dot_host_file', arguments: { requestId,
    action: 'read', path: root + '/dist/services/dot-host-service.js' } })).body.result;
  assert.ok(JSON.stringify(code).includes('class DotHostService'));
  const result = (await rpc('tools/call', { name: 'dot_mac_image', arguments: { requestId } })).body.result;
  assert.equal(result.isError, undefined);
  const image = result.content.find(c => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(Buffer.from(image.data, 'base64').length > 1000);
  console.log(JSON.stringify({ ok: true, actualMac: true, actualMcpHttpTransport: true, unauthenticatedRejected: true,
    realCodeRead: true, realDesktopPixelsInMcpImageBlock: true, webatonAbsent: true,
    cloudDotAndTelegramEndToEnd: 'not tested by this isolated fixture' }));
} finally { bridge.close(); host.close(); await mcp.close(); fs.rmSync(dir, { recursive: true, force: true }); }
