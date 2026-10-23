import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DotMacService } from '../dist/services/dot-mac-service.js';

if (process.platform !== 'darwin') throw Error('Live native UI test requires macOS');
const binary = process.env.DOT_MAC_BINARY ?? path.join(os.homedir(), '.local/bin/peekaboo');
const socket = process.env.DOT_MAC_BRIDGE_SOCKET ?? path.join(os.homedir(), 'Library/Application Support/Peekaboo/daemon.sock');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-mac-live-'));
const service = new DotMacService(dir, binary, socket, true);
const requestId = 'isolated-native-mac-test';
const call = (tool, args = {}) => service.call(`dot_mac_${tool}`, { requestId, ...args });
const ensure = result => { if (result.isError) throw Error(JSON.stringify(result.content)); return result; };
try {
  const status = JSON.parse((await call('status')).content[0].text);
  const definitions = await service.definitions();
  assert.ok(definitions.some(t => t.name === 'dot_mac_see'));
  if (!status.ready) {
    console.log(JSON.stringify({ ok: false, nativeBackendConnected: true, blockedByOsPermissions: true, permissions: status.permissions }));
    process.exitCode = 2;
  } else {
    const page = path.join(dir, 'remoteagent-safari-test.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>RemoteAgent Safari Control Test</title><main><h1>RemoteAgent Safari Control Test</h1><label for="value">RemoteAgent Test Value</label><input id="value" aria-label="RemoteAgent Test Value"><button aria-label="Apply Test Value" onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply Test Value</button></main>');
    ensure(await call('app', { operationId: 'open-test', action: 'open', name: 'Safari', openTargets: [pathToFileURL(page).href], foreground: true, waitForWindow: true }));
    let view;
    for (let i = 0; i < 5; i++) {
      view = ensure(await call('see', { app_target: 'Safari', fresh: true }));
      if (JSON.stringify(view._meta?.ui_elements ?? []).includes('Apply Test Value')) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const elements = view._meta?.ui_elements;
    assert.ok(Array.isArray(elements), 'Native accessibility elements missing');
    const find = label => elements.filter(e => [e.label, e.title, e.description, e.value].includes(label));
    const field = find('RemoteAgent Test Value').filter(e => /text|field/i.test(e.role ?? ''));
    assert.equal(field.length, 1, 'Test input must resolve unambiguously');
    ensure(await call('type', { operationId: 'type-test', text: 'RemoteAgent native Safari verified', on: field[0].id,
      snapshot: view._meta.snapshot_id, clear: true }));
    view = ensure(await call('see', { app_target: 'Safari', fresh: true }));
    const buttons = view._meta.ui_elements.filter(e => [e.label, e.title, e.description].includes('Apply Test Value') && /button/i.test(e.role ?? ''));
    assert.equal(buttons.length, 1, 'Test button must resolve unambiguously');
    ensure(await call('click', { operationId: 'click-test', on: buttons[0].id, snapshot: view._meta.snapshot_id }));
    const after = ensure(await call('see', { app_target: 'Safari', fresh: true }));
    assert.ok(JSON.stringify(after._meta.ui_elements).includes('RemoteAgent native Safari verified'), 'Changed page state not observed');
    const shot = ensure(await call('image', { app_target: 'screen:0' }));
    const image = shot.content.find(c => c.type === 'image');
    assert.ok(image, 'Actual screen image block missing');
    const bytes = Buffer.from(image.data, 'base64');
    assert.ok(bytes.length > 1000, 'Screen image unexpectedly small');
    const output = process.env.MAC_TEST_IMAGE_OUTPUT;
    if (output) fs.writeFileSync(output, bytes, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, realSafari: true, typed: true, clicked: true, observedChangedState: true,
      fullScreenImageBytes: bytes.length, fullScreenImageMimeType: image.mimeType, imageOutput: output,
      note: 'Test tab left visible for inspection; no other tabs or applications closed.' }));
  }
} finally {
  await service.close(); fs.rmSync(dir, { recursive: true, force: true });
}
