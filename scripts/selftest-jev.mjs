import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JevService } from '../dist/services/jev-service.js';
import { readSecretValue, AgentMemoryService } from '../dist/services/agent-memory-service.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remoteagent-jev-'));
const key = 'sk-or-v1-synthetic-test-key';
let calls = 0;
let scenario = 'success';
let choice = 'progress';
let confidence = 0.99;
let lastBody;
const fetcher = async (url, init) => {
  calls++;
  assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(init.headers.Authorization, `Bearer ${key}`);
  lastBody = JSON.parse(init.body);
  assert.equal(lastBody.model, 'typesafe/jev-1.13');
  if (scenario === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error(key))));
  if (scenario === '401') return new Response(key, { status: 401 });
  if (scenario === '429') return new Response(key, { status: 429 });
  if (scenario === 'invalid') return new Response(JSON.stringify({ answers: { status: { type: 'choice', choice: 'execute-shell' } } }));
  if (scenario === 'large') return new Response('x'.repeat(131073));
  if (scenario === 'echo') return new Response(JSON.stringify({ model: key, answers: {} }));
  const answers = Object.fromEntries(Object.entries(lastBody.questions).map(([id, q]) => [id,
    q.type === 'noul' ? { type: q.type, noul: 1 } : q.type === 'score'
      ? { type: q.type, score: 1, confidence: 1, probabilities: {0: 0, 1: 1} }
      : { type: q.type, choice, confidence, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }
  ]));
  return new Response(JSON.stringify({ model: 'typesafe/test', answers }));
};
const request = { state: 'Synthetic data', questions: { check: { type: 'noul', instructions: 'Is text present?' } } };
try {
  const service = new JevService(dir, fetcher, 20);
  assert.equal(service.status().mode, 'off');
  assert.equal((await service.evaluate(request)).reason, 'disabled');
  service.setMode('on');
  assert.equal((await service.evaluate(request)).reason, 'not_configured');
  assert.equal(calls, 0);
  assert.equal((await service.login('invalid')).reason, 'invalid_key_format');
  assert.equal((await service.login(key)).available, true);
  assert.equal(readSecretValue(dir, 'OPENROUTER_API_KEY'), key);
  assert.equal((await fs.stat(path.join(dir, 'managed/secrets.json'))).mode & 0o777, 0o600);
  service.setMode('off');
  assert.equal((await service.login(key)).available, true);
  assert.equal(service.status().mode, 'off', 'Login must not activate classification');
  const memory = new AgentMemoryService(dir);
  const session = {sessionId: 'test', publicId: 'S001', workspace: dir};
  assert.ok(!(await memory.formatProviderContext(session)).includes('REMOTEAGENT_JEV_BIN'));
  service.setMode('observe');
  assert.ok((await memory.formatProviderContext(session)).includes('REMOTEAGENT_JEV_BIN'));
  let r = await service.classify('Finish the task', 'More tests remain', 'unknown');
  assert.equal(r.kind, 'unknown'); assert.equal(r.suggested, 'progress');
  service.setMode('on');
  for (const label of ['progress', 'result', 'blocked', 'unknown']) {
    choice = label;
    r = await service.classify('Task', 'Report', 'unknown');
    assert.equal(r.kind, label);
  }
  const before = calls;
  assert.equal((await service.classify('Task', 'Report', 'result')).kind, 'result');
  assert.equal(calls, before, 'Explicit tags remain authoritative');
  choice = 'progress'; confidence = 0.5;
  assert.equal((await service.classify('Task', 'Report', 'unknown')).kind, 'unknown');
  confidence = 0.99;
  assert.equal((await service.evaluate({ ...request, inputType: 'image' })).reason, 'image_unsupported');
  assert.equal((await service.evaluate({ ...request, state: 'x'.repeat(33000) })).reason, 'invalid_or_oversized_request');
  assert.equal((await service.evaluate({ ...request, state: key })).available, false);
  assert.equal((await service.evaluate({ ...request, endpoint: 'https://example.com' })).available, false);
  const score = await service.evaluate({ state: 'test', questions: { s: { type: 'score', instructions: 'Rate', criteria: ['low', 'high'] } } });
  assert.equal(score.answers.s.score, 1);
  for (const failure of ['401', '429', 'invalid', 'large', 'echo', 'timeout']) {
    scenario = failure;
    const failing = new JevService(dir, fetcher, 10);
    r = await failing.classify('Task', 'Report', 'unknown');
    assert.equal(r.kind, 'unknown');
    const after = calls;
    assert.equal((await failing.evaluate(request)).reason, 'busy_or_cooldown');
    assert.equal(calls, after);
    assert.ok(!JSON.stringify(r).includes(key));
  }
  scenario = '401';
  const failedLogin = await new JevService(dir, fetcher).login(key);
  assert.equal(failedLogin.available, false);
  assert.equal(readSecretValue(dir, 'OPENROUTER_API_KEY'), key, 'Failed validation retains existing key');
  scenario = 'success';
  let release;
  const gated = new JevService(dir, async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return fetcher(...args);
  });
  const inFlight = gated.classify('Task', 'Report', 'unknown');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await gated.evaluate(request)).reason, 'busy_or_cooldown');
  gated.setMode('off');
  release();
  assert.equal((await inFlight).kind, 'unknown', 'Disabling during a request must prevent applying its decision');
  service.setMode('off');
  const file = path.join(dir, 'request.json');
  await fs.writeFile(file, JSON.stringify(request));
  const output = execFileSync(process.execPath, ['bin/remoteagent.js', 'jev', 'evaluate', file, '--data-dir', dir], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).reason, 'disabled');
  console.log('PASS Jev: optional modes, auth, storage, classification, explicit tags, low confidence, image refusal, schema/size guards, timeout, cooldown, redaction and CLI fallback');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
