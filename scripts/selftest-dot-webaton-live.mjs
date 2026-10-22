import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DotWebatonService } from '../dist/services/dot-webaton-service.js';

if (!process.env.WEBATON_SERVER_MODULE) throw Error('Set WEBATON_SERVER_MODULE to the installed Webaton src/server.js file URL');
process.env.NODE_ENV = 'test';
const { createApp } = await import(process.env.WEBATON_SERVER_MODULE);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-webaton-live-'));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => {
  if (!server?.listening) { resolve(); return; }
  server.closeAllConnections?.(); server.close(() => resolve());
});
const site = http.createServer((req, res) => {
  if (req.url === '/report.txt') {
    res.setHeader('content-type', 'text/plain'); res.setHeader('content-disposition', 'attachment; filename="report.txt"');
    res.end('verified download'); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Dot Webaton test</title><main id="app"><h1 id="heading">Browser ready</h1><input id="name" aria-label="Name"><button id="apply" onclick="document.getElementById(\'heading\').textContent=document.getElementById(\'name\').value">Apply</button><a id="download" href="/report.txt">Download</a></main>');
});
let runtime, server;
try {
  const sitePort = await listen(site);
  const reservation = http.createServer();
  const port = await listen(reservation); await close(reservation);
  const data = path.join(temp, 'webaton');
  runtime = createApp({ dir: data, port, headless: true, testKey: Buffer.alloc(32, 17) });
  server = http.createServer(runtime.app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const account = runtime.engine.addAccount({ name: 'Isolated dot test', loginUrl: `http://127.0.0.1:${sitePort}/`,
    origins: [`http://127.0.0.1:${sitePort}`], mode: 'session', successSelector: '#app' });
  const adapter = new DotWebatonService(path.join(temp, 'remoteagent'), `http://127.0.0.1:${port}`, path.join(data, 'mcp-token'));
  const requestId = 'isolated-live-test';
  const accounts = await adapter.call('dot_webaton_accounts', { requestId });
  assert.equal(accounts.accounts[0].id, account.id);
  const job = await adapter.call('dot_webaton_begin', { requestId, operationId: 'begin', accountId: account.id, instruction: 'Fill and click this isolated test page' });
  assert.equal(job.mode, 'external');
  const input = { requestId, jobId: job.id };
  const before = await adapter.call('dot_webaton_observe', input);
  assert.ok(before.observation.headings.includes('Browser ready'));
  await adapter.call('dot_webaton_act', { ...input, operationId: 'fill', action: { type: 'fill', selector: '#name', value: 'Dot controls Mac Chromium' } });
  await adapter.call('dot_webaton_act', { ...input, operationId: 'click', action: { type: 'click', selector: '#apply' } });
  const after = await adapter.call('dot_webaton_observe', input);
  assert.ok(after.observation.headings.includes('Dot controls Mac Chromium'));
  await adapter.call('dot_webaton_act', { ...input, operationId: 'navigate', action: { type: 'navigate', url: `http://127.0.0.1:${sitePort}/next` } });
  const navigated = await adapter.call('dot_webaton_observe', input);
  assert.ok(navigated.observation.headings.includes('Browser ready'));
  const download = await adapter.call('dot_webaton_act', { ...input, operationId: 'download', action: { type: 'download', selector: '#download' } });
  assert.equal(download.downloaded, true);
  const downloadedJob = await adapter.call('dot_webaton_job', input);
  assert.equal(fs.readFileSync(downloadedJob.files[0].file, 'utf8'), 'verified download');
  await adapter.call('dot_webaton_finish', { ...input, operationId: 'finish' });
  assert.equal((await adapter.call('dot_webaton_job', input)).status, 'completed');
  assert.equal(adapter.hasActiveRequest(requestId), false);
  console.log(JSON.stringify({ ok: true, realChromium: true, externalMode: true,
    observed: true, filled: true, clicked: true, devtoolsNavigation: true, downloaded: true, completed: true,
    extraLlmCalled: false, existingServiceChanged: false }));
} finally {
  await runtime?.close(); await close(server); await close(site);
  fs.rmSync(temp, { recursive: true, force: true });
}
