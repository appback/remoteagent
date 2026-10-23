import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {DotOwnerAuthService} from '../dist/services/dot-owner-auth-service.js';
import {DotBridgeService} from '../dist/services/dot-bridge-service.js';
import {DotMcpService} from '../dist/services/dot-mcp-service.js';
import {G2RequestService} from '../dist/services/g2-request-service.js';
import {G2ApiService} from '../dist/services/g2-api-service.js';
import {G2ServerService} from '../dist/services/g2-server-service.js';
import {readG2Clients,g2OriginAllowed} from '../dist/services/g2-config.js';
import {FileStore} from '../dist/store/file-store.js';
import {BridgeService} from '../dist/services/bridge-service.js';
import {spawnWithPlatformShell} from '../dist/adapters/windows-shell.js';
import {execFileSync} from 'node:child_process';

const resource = 'https://bridge.example.test', owner = 'telegram:123', origin = 'https://g2.example.test';
const redirect = origin + '/oauth/callback', clientId = 'remoteagent-g2-test';
const settle = async () => { for(let i=0;i<12;i++) await new Promise(r=>setImmediate(r)); };

async function fixture(t, standalone=false, speech, deviceFlow=false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-g2-'));
  const deliveries=[], telegram=[];
  const dot = new DotBridgeService(dir, owner, async (...args) => {
    const event=JSON.parse(args[4]); deliveries.push(event);
    return event.type === 'verification' ? {status:200,body:JSON.stringify({challenge:event.challenge})} : {status:204,body:''};
  });
  dot.register('bot', async(_chat,text)=>telegram.push(text));
  const channelId=await dot.connect('bot','123');
  const sub = name => dot.subscribe(owner, {name,arguments:{channelId}, delivery:{mode:'webhook',url:'https://callback.example.test/'+name, secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
  await sub('telegram.message.created'); await sub('g2.message.created');
  let calls=0, busy=false, release;
  const sessionId=randomUUID();
  const sessions={
    async listSessions(){return [{sessionId,publicId:'S007',mode:'codex',codex:{provider:'codex',cwd:dir,pairedAt:new Date().toISOString()}}];},
    isSessionBusy(){return busy;},
    isProviderAvailable(){return true;},
    async routeExternalMessage(_session,_provider,_text,signal,onStarted,onProgress){
      calls++; busy=true;
      try {
        signal.throwIfAborted();onStarted();await onProgress({output:'working'});
        await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
        return [{output:'final result'}];
      } finally {busy=false;}
    },
  };
  const service=new G2RequestService(dir,owner,sessions,standalone?undefined:dot);await service.restore();
  const inventory=await service.inventory(), session=inventory.find(t=>t.type==='session'), channel=inventory.find(t=>t.type==='dot_channel');
  const client={clientId,origins:[origin],redirectUris:deviceFlow?[]:[redirect],targetIds:inventory.map(t=>t.targetId),deviceFlow};
  const auth=new DotOwnerAuthService(dir,resource,owner,[client],!standalone);
  const api=new G2ApiService(service,resource,[client],auth.authenticateG2.bind(auth),speech);
  const mcp=standalone ? new G2ServerService(auth.handle.bind(auth),api.handle.bind(api))
    : new DotMcpService(dot,'127.0.0.1',0,{resource,issuer:auth.issuer},auth.authenticate.bind(auth),auth.handle.bind(auth),undefined,undefined,api.handle.bind(api));
  await mcp.start(0);
  t.after(async()=>{release?.();await settle();dot.close();await mcp.close();fs.rmSync(dir,{recursive:true,force:true});});
  const cookies=new Map();
  async function request(url,options={}) {
    const target=new URL(url,resource);
    const response=await fetch('http://127.0.0.1:'+mcp.address().port+target.pathname+target.search, {...options,redirect:'manual',headers:{
      host:'bridge.example.test','x-forwarded-host':'bridge.example.test','x-forwarded-proto':'https',
      cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...options.headers,
    }});
    for(const cookie of response.headers.getSetCookie()){const [k,v]=cookie.split(';')[0].split('=');cookies.set(k,v);}
    return response;
  }
  async function login({wrongVerifier=false}={}) {
    const verifier=randomBytes(48).toString('base64url'), challenge=createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',scope:'remoteagent:g2',resource:resource+'/api/v1',state:'flow-state',code_challenge:challenge,code_challenge_method:'S256',prompt:'consent'});
    let response=await request('/oauth/auth?'+params);
    assert.equal(response.status,303,await response.clone().text());
    const location=response.headers.get('location');response=await request(location);
    assert.equal(response.status,200,await response.clone().text());
    const html=await response.text(), csrf=/name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(html.includes('G2 앱'));assert.ok(csrf);
    response=await request(location,{method:'POST',headers:{origin:resource,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,code:auth.issueLoginCode().code})});
    for(let i=0;i<8;i++) {
      assert.ok([302,303].includes(response.status),await response.clone().text());
      const next=response.headers.get('location');
      if(next.startsWith(redirect)) {
        const callback=new URL(next);assert.equal(callback.searchParams.get('state'),'flow-state');assert.equal(callback.searchParams.get('iss'),auth.issuer);
        const exchange=()=>request('/oauth/token',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,code:callback.searchParams.get('code'),resource:resource+'/api/v1',code_verifier:wrongVerifier?'wrong':verifier})});
        const tokenResponse=await exchange();
        return {response:tokenResponse,tokens:await tokenResponse.json(),exchange};
      }
      response=await request(next);
    }
    throw Error('G2 OAuth did not finish');
  }
  const principal={subject:owner,clientId,expiresAt:Date.now()+3600000,targetIds:client.targetIds};
  const input=(target=session, key=randomUUID())=>({targetId:target.targetId,clientRequestId:key,text:'test instruction'});
  return {dir,dot,service,sessions,client,auth,api,mcp,request,login,principal,session,channel,sub,deliveries,telegram,channelId,input,
    calls:()=>calls, release:()=>release?.(), busy:value=>{busy=value;}};
}

test('standalone G2 runs sessions without dot clients, MCP, channels or host tools',async t=>{
  const f=await fixture(t,true);
  assert.equal((await f.request('/mcp',{method:'POST',body:'{}'})).status,404);
  assert.equal((await f.request('/.well-known/oauth-protected-resource')).status,404);
  assert.equal(await f.auth.provider.Client.find('remoteagent-dot'),undefined);
  assert.equal((await f.request('/api/v1/targets')).status,401);
  const login=await f.login();assert.equal(login.response.status,200,JSON.stringify(login.tokens));
  const bearer='Bearer '+login.tokens.access_token;
  const targets=await f.request('/api/v1/targets',{headers:{authorization:bearer,origin}});
  assert.deepEqual((await targets.json()).targets.map(t=>t.label),['S007']);
  assert.equal(await f.auth.authenticate(bearer),undefined);
  const submitted=await f.service.submit(await f.auth.authenticateG2(bearer),f.input());
  await settle();assert.equal(f.calls(),1);f.release();await settle();
  assert.equal(f.service.get(f.principal,submitted.requestId).status,'completed');
  assert.equal(f.telegram.length,0);
  assert.equal((await f.request('/mcp',{method:'POST',headers:{authorization:bearer},body:'{}'})).status,404);
});

test('PCM API is authenticated, target-bound, bounded and never executes a transcript',async t=>{
  let calls=0;
  const f=await fixture(t,true,{async transcribe(bytes){calls++;assert.equal(bytes.length,6400);return {text:'실제 입력은 별도 전송',durationMs:200};}});
  const login=await f.login(),headers={authorization:'Bearer '+login.tokens.access_token,'content-type':'audio/pcm',origin};
  const url='/api/v1/audio/transcriptions?targetId='+f.session.targetId;
  assert.equal((await f.request(url,{method:'POST',body:Buffer.alloc(6400)})).status,401);
  assert.equal((await f.request(url.replace(f.session.targetId,'tgt_unknown'),{method:'POST',headers,body:Buffer.alloc(6400)})).status,403);
  assert.equal((await f.request(url,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status,415);
  assert.equal((await f.request(url,{method:'POST',headers,body:Buffer.alloc(1920002)})).status,413);
  const result=await f.request(url,{method:'POST',headers,body:Buffer.alloc(6400)});
  assert.equal(result.status,200);assert.equal((await result.json()).text,'실제 입력은 별도 전송');
  assert.equal(calls,1);assert.equal(f.calls(),0);
});

test('trusted Telegram owner approves standard device grant without browser/copy codes; deny, expiry and replay fail closed',async t=>{
  const f=await fixture(t,true,undefined,true);
  const form=body=>({method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
  const create=async()=>{
    const result=await f.request('/oauth/device/auth',form({client_id:clientId,scope:'remoteagent:g2',resource:resource+'/api/v1'}));
    assert.equal(result.status,200,await result.clone().text());return result.json();
  };
  const input=await create();
  const preview=await f.auth.previewG2Device(input.user_code);assert.deepEqual(preview.targetIds,[f.session.targetId]);
  await assert.rejects(f.auth.decideG2Device(input.user_code,true,'telegram:another-user'),/UNAUTHORIZED/);
  const decisions=await Promise.allSettled([f.auth.decideG2Device(input.user_code,true,owner),f.auth.decideG2Device(input.user_code,true,owner)]);
  assert.equal(decisions.filter(x=>x.status==='fulfilled').length,1);
  const fields={grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:clientId,device_code:input.device_code,resource:resource+'/api/v1'};
  const exchange=await f.request('/oauth/token',form(fields));assert.equal(exchange.status,200,await exchange.clone().text());
  const tokens=await exchange.json();assert.ok(tokens.access_token);assert.ok(tokens.refresh_token);
  assert.equal((await f.auth.authenticateG2('Bearer '+tokens.access_token)).targetIds.length,1);
  await assert.rejects(f.auth.previewG2Device(input.user_code),/INVALID_DEVICE_CODE/);
  const denied=await create();await f.auth.decideG2Device(denied.user_code,false,owner);
  const denial=await f.request('/oauth/token',form({...fields,device_code:denied.device_code}));
  assert.equal(denial.status,400);assert.equal((await denial.json()).error,'access_denied');
  const expired=await create();const row=await f.auth.provider.DeviceCode.findByUserCode(expired.user_code.replace(/-/g,''));await row.destroy();
  await assert.rejects(f.auth.decideG2Device(expired.user_code,true,owner),/INVALID_DEVICE_CODE/);
});

test('G2 real-library OAuth PKCE, CORS, resource isolation and revocation',async t=>{
  const f=await fixture(t),login=await f.login();
  assert.equal(login.response.status,200,JSON.stringify(login.tokens));
  assert.equal(login.response.headers.get('access-control-allow-origin'),origin);
  assert.ok(login.tokens.access_token);assert.equal(login.tokens.refresh_token,undefined);
  const bearer='Bearer '+login.tokens.access_token;
  assert.equal((await f.auth.authenticateG2(bearer)).clientId,clientId);
  assert.equal(await f.auth.authenticate(bearer),undefined,'G2 token must never authorize MCP/host tools');
  const targets=await f.request('/api/v1/targets',{headers:{authorization:bearer,origin}});
  assert.equal(targets.status,200);assert.equal((await targets.json()).targets.length,2);
  assert.equal((await f.request('/mcp',{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:'{}'})).status,401);
  const token=await f.auth.provider.AccessToken.find(login.tokens.access_token);await(await f.auth.provider.Grant.find(token.grantId)).destroy();
  assert.equal((await f.request('/api/v1/targets',{headers:{authorization:bearer}})).status,401);
  assert.equal((await login.exchange()).status,400);
  assert.equal((await f.login({wrongVerifier:true})).response.status,400);
});

test('configuration validates explicit origins, callbacks and target allowlists',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g2-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'clients.json');
  const valid={clientId,origins:[origin],redirectUris:[redirect],targetIds:['tgt_'+'a'.repeat(32)]};
  fs.writeFileSync(file,JSON.stringify({clients:[valid]}));assert.deepEqual(readG2Clients(file),[valid]);
  for(const bad of [{...valid,redirectUris:['https://evil.test/cb']},{...valid,origins:['http://g2.example.test']},{...valid,targetIds:['*']},{...valid,clientId:'remoteagent-dot'}]) {
    fs.writeFileSync(file,JSON.stringify({clients:[bad]}));assert.throws(()=>readG2Clients(file));
  }
});

test('device clients explicitly allow numeric loopback WebViews without LAN/null/wildcard CORS',()=>{
  const client={clientId,deviceFlow:true,loopbackOrigin:true,origins:[],redirectUris:[],targetIds:[]};
  for(const allowed of ['http://127.0.0.1:8080','http://127.0.0.1:65535'])assert.equal(g2OriginAllowed(client,allowed),true);
  for(const denied of ['null','http://localhost:8080','http://192.168.33.60:8080','http://127.0.0.1:80','http://127.0.0.1:8080/','http://127.0.0.1:8080/path','http://user@127.0.0.1:8080','https://evil.test'])assert.equal(g2OriginAllowed(client,denied),false);
  assert.equal(g2OriginAllowed({...client,loopbackOrigin:false},'http://127.0.0.1:8080'),false);
});

test('durable target IDs, restricted inventory and no unauthenticated local API exposure',async t=>{
  const f=await fixture(t);
  const restored=new G2RequestService(f.dir,owner,f.sessions,f.dot);
  assert.deepEqual((await restored.inventory()).map(t=>t.targetId),(await f.service.inventory()).map(t=>t.targetId));
  const onlySession={...f.principal,targetIds:[f.session.targetId]};
  const targets=await f.service.targets(onlySession);assert.equal(targets.length,1);assert.equal(targets[0].provider,'codex');
  assert.equal('reference' in targets[0],false);
  assert.equal((await f.request('/api/v1/targets')).status,401);
  assert.equal((await f.request('/api/sessions')).status,404);
  assert.equal((await f.request('/api/v1/targets',{headers:{origin:'https://evil.test'}})).status,403);
});

test('operator inventory uses the same IDs without modifying Telegram/dot runtime state',async t=>{
  const f=await fixture(t),sessions=await f.sessions.listSessions();
  fs.writeFileSync(path.join(f.dir,'state.json'),JSON.stringify({sessions:Object.fromEntries(sessions.map(session=>[session.sessionId,session]))}));
  const bridgeFile=path.join(f.dir,'dot','bridge.json'),before=fs.readFileSync(bridgeFile);
  const output=execFileSync(process.execPath,['scripts/g2-targets.mjs','--data-dir',f.dir],{encoding:'utf8'});
  assert.deepEqual(JSON.parse(output).targets.map(target=>target.targetId),(await f.service.inventory()).map(target=>target.targetId));
  assert.deepEqual(fs.readFileSync(bridgeFile),before);
});

test('concurrent duplicate submission executes once, preserves progress and replays result',async t=>{
  const f=await fixture(t),input=f.input();
  const [a,b]=await Promise.all([f.service.submit(f.principal,input),f.service.submit(f.principal,input)]);
  assert.equal(a.requestId,b.requestId);assert.equal(a.status,'accepted');assert.equal(b.replayed,true);
  await settle();assert.equal(f.calls(),1);
  await assert.rejects(f.service.submit(f.principal,{...input,text:'changed'}),/REQUEST_ID_CONFLICT/);
  await assert.rejects(f.service.submit(f.principal,f.input()),/TARGET_BUSY/);
  f.release();await settle();
  const result=f.service.get(f.principal,a.requestId);assert.equal(result.status,'completed');assert.equal(result.result.outcome,'unknown');
  const events=f.service.events(f.principal,a.requestId,0,2);assert.equal(events.hasMore,true);assert.equal(events.nextCursor,2);
  const tail=f.service.events(f.principal,a.requestId,events.nextCursor,100);assert.ok(tail.events.every(e=>e.seq>2));
  assert.equal(tail.events.at(-1).type,'result');
  assert.equal((await f.service.submit(f.principal,input)).requestId,a.requestId);
  assert.throws(()=>f.service.get({...f.principal,clientId:'remoteagent-g2-other'},a.requestId),/REQUEST_NOT_FOUND/);
  assert.throws(()=>f.service.get({...f.principal,targetIds:[]},a.requestId),/TARGET_FORBIDDEN/);
});

test('dot G2 event filter and reports do not leak into Telegram; Telegram remains functional',async t=>{
  const f=await fixture(t),row=await f.service.submit(f.principal,f.input(f.channel));await settle();
  const delivered=f.deliveries.find(e=>e.eventId===row.requestId);
  assert.equal(delivered.name,'g2.message.created');assert.equal(delivered.data.channelId,f.channelId);
  assert.equal(f.dot.read(owner,row.requestId).origin,'g2');assert.equal(f.service.get(f.principal,row.requestId).status,'accepted');
  const report={requestId:row.requestId,reportId:'progress',kind:'progress',text:'G2 progress'};
  await f.dot.report(owner,report);await f.dot.report(owner,report);
  assert.equal(f.service.events(f.principal,row.requestId,0,100).events.filter(e=>e.type==='progress').length,1);
  await f.dot.report(owner,{...report,reportId:'result',kind:'result',text:'G2 final',outcome:'succeeded'});
  assert.equal(f.service.get(f.principal,row.requestId).result.outcome,'succeeded');assert.equal(f.telegram.length,0);
  const telegramId=await f.dot.enqueue('bot','123','telegram-update','Telegram request');await settle();
  assert.equal(f.deliveries.find(e=>e.eventId===telegramId).name,'telegram.message.created');
  await f.dot.report(owner,{requestId:telegramId,reportId:'tg',kind:'result',text:'Telegram final'});
  assert.equal(f.telegram.length,1);assert.match(f.telegram[0],/Telegram final/);
});

test('cancel reports execution scope for sessions and delivery-only scope for dot',async t=>{
  const f=await fixture(t),row=await f.service.submit(f.principal,f.input());await settle();
  assert.equal((await f.service.cancel(f.principal,row.requestId)).status,'cancel_requested');await settle();
  const canceled=f.service.get(f.principal,row.requestId);assert.equal(canceled.status,'canceled');assert.equal(canceled.cancel.executionStopped,true);
  const dot=await f.service.submit(f.principal,f.input(f.channel));await settle();
  const result=await f.service.cancel(f.principal,dot.requestId);assert.equal(result.status,'canceled');assert.equal(result.cancel.scope,'delivery_only');assert.equal(result.cancel.executionStopped,false);
  await assert.rejects(f.dot.report(owner,{requestId:dot.requestId,reportId:'late',kind:'result',text:'late'}),/DOT_REQUEST_CLOSED/);
});

test('G2 subscription expiry/unsubscribe does not remove Telegram subscription',async t=>{
  const f=await fixture(t);
  await f.dot.unsubscribe(owner,{name:'g2.message.created',arguments:{channelId:f.channelId},delivery:{mode:'webhook',url:'https://callback.example.test/g2.message.created'}});
  await assert.rejects(f.service.submit(f.principal,f.input(f.channel)),/DOT_NOT_SUBSCRIBED/);
  const id=await f.dot.enqueue('bot','123','still-telegram','works');await settle();
  assert.ok(f.deliveries.some(e=>e.eventId===id));
});

test('restart marks unfinished G2 work interrupted and does not replay dot request',async t=>{
  const f=await fixture(t),input=f.input(f.channel),row=await f.service.submit(f.principal,input);await settle();
  const count=f.deliveries.filter(e=>e.eventId===row.requestId).length;
  const restored=new G2RequestService(f.dir,owner,f.sessions,f.dot);await restored.restore();await f.dot.pump();
  assert.equal(restored.get(f.principal,row.requestId).status,'interrupted');
  assert.equal((await restored.submit(f.principal,input)).replayed,true);
  assert.equal(f.deliveries.filter(e=>e.eventId===row.requestId).length,count);
});

test('API accepted/status/events/cancel contract and exact-origin preflight',async t=>{
  const f=await fixture(t),login=await f.login();assert.equal(login.response.status,200,JSON.stringify(login.tokens));
  const headers={authorization:'Bearer '+login.tokens.access_token,origin,'content-type':'application/json'};
  const response=await f.request('/api/v1/requests',{method:'POST',headers,body:JSON.stringify(f.input())});assert.equal(response.status,202);
  const row=await response.json();assert.ok(response.headers.get('location').endsWith(row.requestId));
  const events=await f.request('/api/v1/requests/'+row.requestId+'/events?after=0&limit=100',{headers});assert.equal(events.status,200);assert.ok((await events.json()).events.length);
  assert.equal((await f.request('/api/v1/requests/'+row.requestId+'/events?after=-1',{headers})).status,400);
  assert.equal((await f.request('/api/v1/requests/'+row.requestId+'/cancel',{method:'POST',headers,body:'{}'})).status,202);
  await settle();assert.equal((await(await f.request('/api/v1/requests/'+row.requestId,{headers})).json()).status,'canceled');
  const preflight=await f.request('/api/v1/requests',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization, content-type'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);assert.equal(preflight.headers.has('access-control-allow-credentials'),false);
});

test('unapproved callback/scope, malformed requests, body size and rate limits are rejected',async t=>{
  const f=await fixture(t);
  const verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  for(const overrides of [{redirect_uri:'https://evil.test/callback'},{scope:'remoteagent:dot',resource},{resource}]) {
    const params=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',scope:'remoteagent:g2',resource:resource+'/api/v1',state:'bad-flow',code_challenge:challenge,code_challenge_method:'S256',...overrides});
    const start=await f.request('/oauth/auth?'+params);
    if([302,303].includes(start.status)&&start.headers.get('location')?.startsWith(resource+'/oauth/interaction/')) {
      const page=await f.request(start.headers.get('location'));assert.equal(page.status,400);
    } else assert.ok(start.status>=400||start.headers.get('location')?.includes('error='));
  }
  await assert.rejects(f.service.submit(f.principal,{...f.input(),telegram:true}),/INVALID_REQUEST/);
  await assert.rejects(f.service.submit(f.principal,{...f.input(),text:'가'.repeat(12000)}),/REQUEST_TOO_LARGE/);
  await assert.rejects(f.service.submit({...f.principal,targetIds:[]},f.input()),/TARGET_FORBIDDEN/);
  const login=await f.login();assert.equal(login.response.status,200,JSON.stringify(login.tokens));
  const headers={authorization:'Bearer '+login.tokens.access_token,origin,'content-type':'application/json'};
  assert.equal((await f.request('/api/v1/requests',{method:'POST',headers,body:'[]'})).status,400);
  assert.equal((await f.request('/api/v1/requests',{method:'POST',headers,body:'{"text":"'+'a'.repeat(65536)+'"}'})).status,413);
  let limited;
  for(let i=0;i<12;i++){limited=await f.request('/api/v1/requests',{method:'POST',headers,body:'{}'});if(limited.status===429)break;}
  assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
});

test('real BridgeService cancellation holds the lock and never stops another session process',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g2-provider-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new FileStore(dir,'codex');await store.init();
  const own=await store.createSessionForChat('own','owner',dir,'codex'), other=await store.createSessionForChat('other','owner',dir,'codex');
  for(const item of [own,other])await store.upsertProviderForSession(item.session.sessionId,'codex',{cwd:dir,pairedAt:new Date().toISOString()},dir);
  let ready;const observed=new Promise(resolve=>ready=resolve);
  const adapter={async send(request){
    const code=request.message==='other' ? "setTimeout(()=>console.log('OTHER_DONE'),600)" : "console.log('OWN_READY');setTimeout(()=>console.log('OWN_DONE'),10000)";
    const output=await spawnWithPlatformShell(process.execPath,['-e',code],dir,15000,undefined,request.remoteSessionId,undefined,
      async line=>{await request.onProgress?.(line);if(line==='OWN_READY')ready();});
    return {provider:'codex',sessionId:request.sessionId??'fixture-thread',cwd:dir,output:output.stdout};
  }};
  const bridge=new BridgeService(store,{codex:adapter},dir,dir,()=>true,'codex');
  const controller=new AbortController();
  const ownRun=bridge.routeExternalMessage(own.session.sessionId,'codex','own',controller.signal,()=>{},()=>{});
  await observed;
  await assert.rejects(bridge.routeExternalMessage(own.session.sessionId,'codex','duplicate',new AbortController().signal,()=>{},()=>{}),/TARGET_BUSY/);
  const otherRun=bridge.routeSessionMessage(other.session.sessionId,'other');
  controller.abort();const output=await ownRun;
  assert.ok(output[0].output.includes('OWN_READY'));assert.equal(output[0].output.includes('OWN_DONE'),false);
  assert.ok((await otherRun)[0].output.includes('OTHER_DONE'));
  assert.equal(bridge.isSessionBusy(own.session.sessionId),false);
});

test('event ring returns CURSOR_EXPIRED, disk errors fail closed, expired terminal rows are pruned',async t=>{
  const f=await fixture(t);let now=Date.now();
  const sessions={...f.sessions,async routeExternalMessage(_s,_p,_text,_signal,onStarted,onProgress){onStarted();for(let i=0;i<160;i++)await onProgress({output:'progress '+i});return [{output:'done'}];}};
  const service=new G2RequestService(f.dir,owner,sessions,f.dot,()=>now);
  const row=await service.submit(f.principal,f.input());await settle();
  assert.throws(()=>service.events(f.principal,row.requestId,0,100),/CURSOR_EXPIRED/);
  const snapshot=service.get(f.principal,row.requestId);assert.equal(snapshot.status,'completed');
  assert.equal(service.events(f.principal,row.requestId,snapshot.lastSeq-1,100).events[0].type,'result');
  now+=8*86400000;
  assert.throws(()=>service.get({...f.principal,expiresAt:now+3600000},row.requestId),/REQUEST_NOT_FOUND/);
  fs.rmSync(path.join(f.dir,'g2','requests'),{recursive:true});
  await assert.rejects(service.submit({...f.principal,expiresAt:now+3600000},f.input()),/G2_STORAGE_FAILED/);
  await assert.rejects(service.submit({...f.principal,expiresAt:now+3600000},f.input()),/G2_STORAGE_FAILED/);
});
