import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FileStore} from '../dist/store/file-store.js';
import {SessionDispatchService} from '../dist/services/session-dispatch-service.js';
import {LocalUiService} from '../dist/services/local-ui-service.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ra-dispatch-'));
try{
 const store=new FileStore(dir,'codex');await store.init();
 const a=await store.createSessionForChat('a','owner',dir,'codex');
 const b=await store.createSessionForChat('b','owner',dir,'codex');
 const service=new SessionDispatchService(store);let release,calls=0;
 const gate=new Promise(r=>release=r);
 service.register('a',async()=>['source report']);
 service.register('b',async input=>{assert.equal(input.chatId,'owner');assert.equal(input.source,a.session.publicId);calls++;await gate;return ['actual target report'];});
 const token=await fs.readFile(path.join(dir,'dispatches/token'),'utf8');
 assert.equal(service.authorize('Bearer '+token),true);assert.equal(service.authorize('Bearer wrong'),false);
 const requestId=randomUUID();
 const [r1,r2]=await Promise.all([service.submit(a.session.sessionId,b.session.publicId,'task',requestId),service.submit(a.session.sessionId,b.session.publicId,'task',requestId)]);
 assert.equal(r1.id,r2.id);assert.equal(calls,1);
 await assert.rejects(()=>service.submit(a.session.sessionId,b.session.publicId,'changed',requestId),/REQUEST_ID_CONFLICT/);
 await assert.rejects(()=>service.submit(b.session.sessionId,a.session.publicId,'cycle',randomUUID()),/DISPATCH_CYCLE/);
 await assert.rejects(()=>service.submit(a.session.sessionId,a.session.publicId,'self',randomUUID()),/SELF_DISPATCH/);
 assert.equal(service.get(r1.id,b.session.sessionId),undefined);
 const restored=new SessionDispatchService(store);assert.equal(restored.get(r1.id,a.session.sessionId).status,'interrupted');
 release();await new Promise(r=>setImmediate(r));assert.equal(service.get(r1.id,a.session.sessionId).status,'reported');
 assert.deepEqual(service.get(r1.id,a.session.sessionId).report,['actual target report']);
 const unbound=await store.createSessionForChat('not-configured','owner',dir,'codex');
 service.registerUnbound(async input=>{assert.equal(input.chatId,'');return ['unbound target result'];});
 const withoutTelegram=await service.submit(a.session.sessionId,unbound.session.publicId,'unbound task',randomUUID());
 await new Promise(r=>setImmediate(r));assert.deepEqual(service.get(withoutTelegram.id,a.session.sessionId).report,['unbound target result']);
 await assert.rejects(()=>service.submit(a.session.sessionId,'S999','missing',randomUUID()),/SESSION_NOT_FOUND/);
 service.register('b',async()=>{throw Error('Telegram unavailable');});
 const failed=await service.submit(a.session.sessionId,b.session.publicId,'another task',randomUUID());
 await new Promise(r=>setImmediate(r));assert.equal(service.get(failed.id,a.session.sessionId).status,'failed');
 const api=new LocalUiService({dispatch:service},'127.0.0.1',0);await api.start();
 try{
  const url='http://127.0.0.1:'+api.address().port;
  assert.equal((await fetch(url+'/api/dispatch-targets')).status,401);
  const headers={authorization:'Bearer '+token,'x-source-session':a.session.sessionId,'content-type':'application/json'};
  assert.equal((await fetch(url+'/api/dispatch-targets',{headers:{...headers,origin:'https://other.test'}})).status,401);
  const response=await fetch(url+'/api/dispatches',{method:'POST',headers,body:JSON.stringify({target:b.session.publicId,message:'http task',requestId:randomUUID()})});
  assert.equal(response.status,202);const accepted=await response.json();
  assert.equal((await fetch(url+'/api/dispatches/'+accepted.receipt.id,{headers:{...headers,'x-source-session':b.session.sessionId}})).status,404);
  service.register('b',async()=>['CLI receiver response']);
  const instruction=path.join(dir,'task.txt');await fs.writeFile(instruction,'CLI fixture task');
  const result=await promisify(execFile)(process.execPath,['dist/session-helper.js','send',b.session.publicId,instruction],{
    env:{...process.env,REMOTEAGENT_DATA_DIR:dir,REMOTEAGENT_SESSION_ID:a.session.sessionId,LOCAL_UI_PORT:String(api.address().port)},timeout:8000,
  });
  assert.deepEqual(JSON.parse(result.stdout).receipt.report,['CLI receiver response']);
  assert.equal(JSON.parse(result.stdout).receipt.status,'reported');
 }finally{await api.close();}
 console.log('PASS session dispatch: concurrent replay, scope, cycles, report routing, failure, restart without replay');
}finally{await fs.rm(dir,{recursive:true,force:true});}
