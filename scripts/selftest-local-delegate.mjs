import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { LocalDelegate } from '../dist/services/local-delegate.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-delegate-'));
let mode = 'ok', calls = 0;
const server = http.createServer(async (req,res) => {
  calls++;
  let body=''; for await (const chunk of req) body+=chunk;
  const parsed=JSON.parse(body);
  assert.equal(parsed.tools,undefined);
  assert.equal(parsed.model,'test-local');
  if(mode==='wait') return;
  if(mode==='error'){res.writeHead(503);res.end();return;}
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({choices:[{message:{content:mode==='large'?'x'.repeat(17000):'Finding with context reference'},finish_reason:mode==='truncated'?'length':'stop'}],usage:{prompt_tokens:20,completion_tokens:8}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const original={...process.env};
try {
  const service=new LocalDelegate(dir);
  const request={instruction:'Extract endpoint',context:'GET /health',acceptance:'Return path and reference'};
  delete process.env.LOCAL_DELEGATE_ENABLED;
  await assert.rejects(service.run(request,()=>{}),/disabled/);
  process.env.LOCAL_DELEGATE_ENABLED='1';
  process.env.LOCAL_DELEGATE_URL=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  process.env.LOCAL_DELEGATE_MODEL='test-local';
  const job=await service.run(request,()=>{});
  assert.equal(job.status,'returned');assert.equal(job.reviewed,false);
  assert.equal((await service.status(job.id)).usage.completion_tokens,8);
  for(const next of ['error','large','truncated']){mode=next;assert.equal((await service.run(request,()=>{})).status,'failed');}
  assert.equal(calls,4,'no automatic retries');
  mode='wait';
  let announce; const announced=new Promise(resolve=>announce=resolve);
  const running=service.run(request,announce);
  const id=await announced;
  await assert.rejects(new LocalDelegate(dir).run(request,()=>{}),/locked/);
  assert.equal(await service.cancel(id),'cancel_requested');
  assert.equal((await running).status,'cancelled');
  await assert.rejects(service.status('../state'),/Invalid/);
  assert.ok(!(await fs.readFile(path.join(dir,'delegations',`${job.id}.json`),'utf8')).includes('GET /health'));
  console.log('PASS local delegate: opt-in, response, usage, no retries, errors, limits, cancellation, global lock, ID validation');
} finally {
  for(const key of ['LOCAL_DELEGATE_ENABLED','LOCAL_DELEGATE_URL','LOCAL_DELEGATE_MODEL']) {
    if(original[key]===undefined) delete process.env[key]; else process.env[key]=original[key];
  }
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  await fs.rm(dir,{recursive:true,force:true});
}
