import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DotMacService } from '../dist/services/dot-mac-service.js';
import { DotMacScreenService } from '../dist/services/dot-mac-screen-service.js';

if (process.platform !== 'darwin') throw Error('Requires a logged-in macOS GUI session');
const dir = fs.mkdtempSync('/private/tmp/dot-direct-live-');
const screen = new DotMacScreenService();
const service = new DotMacService(dir, process.env.HOME + '/.local/bin/peekaboo',
  process.env.HOME + '/Library/Application Support/Peekaboo/daemon.sock', true, [], screen);
const requestId = 'isolated-direct-ui-test';
const call = async (name, args) => {
  const result = await service.call('dot_mac_' + name, { requestId, ...args });
  if (result.isError && result._meta?.mutation_dispatched !== true) throw Error(JSON.stringify(result));
  if (result._meta?.mutation_dispatched === true) await service.call('dot_mac_image', { requestId });
  return result;
};
try {
  const page = path.join(dir, 'test.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>RemoteAgent direct Mac test</title><style>body{font:32px system-ui;margin:40px}button,input{font:28px system-ui;display:block;margin:20px 0;padding:12px}</style><h1>RemoteAgent direct Mac test</h1><input aria-label="Test input" placeholder="Test input"><button onclick="document.querySelector(\'h1\').textContent=\'CLICK VERIFIED\'">Verify click</button><p>Isolated test page. No production data.</p><script>onhashchange=()=>document.querySelector("h1").textContent="KEYBOARD VERIFIED"</script>');
  await call('app', { operationId: 'open', action: 'open', name: 'Safari', openTargets: [pathToFileURL(page).href], foreground: true, waitForWindow: true });
  await call('press', { operationId: 'focus-location', keys: ['cmd+l'], foreground: true });
  await call('type', { operationId: 'type-location', text: pathToFileURL(page).href + '#keyboard-verified', foreground: true });
  await call('press', { operationId: 'navigate', keys: ['Return'], foreground: true });
  await new Promise(r => setTimeout(r, 1200));
  const shot = await call('image', {});
  const image = shot.content.find(c => c.type === 'image'); assert.ok(image);
  if (process.env.MAC_TEST_IMAGE_OUTPUT) fs.writeFileSync(process.env.MAC_TEST_IMAGE_OUTPUT, Buffer.from(image.data, 'base64'), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, realScreenCaptured: true, safariOpened: true, keyboardDispatched: true,
    verifiedPermission: screen.verified, status: JSON.parse((await call('status', {})).content[0].text),
    instruction: 'Inspect screenshot and native window bounds before a coordinate click. Keyboard dispatch alone is not semantic verification.',
    window: await call('window', { operationId: 'windows', action: 'list', app: 'Safari' }) }));
} finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
