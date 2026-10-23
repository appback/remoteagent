import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DotOwnerAuthService} from '../dist/services/dot-owner-auth-service.js';
import {DotBridgeService} from '../dist/services/dot-bridge-service.js';
import {DotMcpService} from '../dist/services/dot-mcp-service.js';
import {G2RequestService} from '../dist/services/g2-request-service.js';
import {G2ApiService} from '../dist/services/g2-api-service.js';
import {G2ServerService} from '../dist/services/g2-server-service.js';

const {chromium}=await import(process.env.PLAYWRIGHT_PACKAGE||'playwright');
const deviceFlow=process.env.G2_DEVICE_FLOW_TEST==='1';
const standalone=process.env.G2_STANDALONE_TEST==='1';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g2-browser-'));
const keyFile=path.join(dir,'key.pem'),certFile=path.join(dir,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
const tls={key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)};
const uiHandler=(_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>G2 OAuth fixture</title><p>G2 OAuth test</p>');
const ui=deviceFlow?http.createServer(uiHandler):https.createServer(tls,uiHandler);
let backendPort;
const proxy=https.createServer(tls,(req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,
    headers:{...req.headers,'x-forwarded-proto':'https','x-forwarded-host':new URL(resource).host}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);
});
await new Promise(resolve=>ui.listen(0,'127.0.0.1',resolve));
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const origin=`${deviceFlow?'http':'https'}://127.0.0.1:${ui.address().port}`,resource=`https://127.0.0.1:${proxy.address().port}`;
const owner='telegram:g2-browser',clientId='remoteagent-g2-browser',redirect=origin+'/oauth/callback';
const dot=new DotBridgeService(dir,owner,async()=>{throw Error('No external webhook expected');});
const sessions={async listSessions(){return [{sessionId:'browser-session',publicId:'S001',mode:'codex',codex:{cwd:dir,pairedAt:new Date().toISOString()}}];},
  isSessionBusy(){return false;},isProviderAvailable(){return true;},
  async routeExternalMessage(_id,_provider,_text,_signal,started,progress){started();await progress({output:'browser progress'});return [{output:'browser final'}];}};
const requests=new G2RequestService(dir,owner,sessions,standalone?undefined:dot);await requests.restore();
const targets=await requests.inventory();
const client={clientId,origins:deviceFlow?[]:[origin],redirectUris:deviceFlow?[]:[redirect],targetIds:targets.map(target=>target.targetId),deviceFlow,loopbackOrigin:deviceFlow};
const auth=new DotOwnerAuthService(dir,resource,owner,[client],!standalone);
const api=new G2ApiService(requests,resource,[client],auth.authenticateG2.bind(auth));
const mcp=standalone ? new G2ServerService(auth.handle.bind(auth),api.handle.bind(api))
  : new DotMcpService(dot,'127.0.0.1',0,{resource,issuer:auth.issuer},auth.authenticate.bind(auth),auth.handle.bind(auth),undefined,undefined,api.handle.bind(api));
await mcp.start(0);backendPort=mcp.address().port;
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
  const page=await browser.newPage({ignoreHTTPSErrors:true});
  // Block everything except these two local TLS origins: no production credentials,
  // ChatGPT requests, Telegram calls or real G2 hardware are used by this fixture.
  await page.route('**/*',route=>[origin,resource].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  const verifier=randomBytes(48).toString('base64url'),state=randomBytes(24).toString('base64url');
  await page.goto(origin);
  let device;
  if(deviceFlow){
    device=await page.evaluate(async({resource,clientId})=>{
      const response=await fetch(resource+'/oauth/device/auth',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,scope:'remoteagent:g2',resource:resource+'/api/v1'})});
      if(!response.ok)throw Error('Device authorization failed: '+response.status);return response.json();
    },{resource,clientId});
    assert.ok(device.device_code);assert.ok(device.user_code);
    const verificationResponse=await page.goto(device.verification_uri_complete,{waitUntil:'networkidle'});
    if(await page.getByRole('button',{name:'일치합니다'}).count())await page.getByRole('button',{name:'일치합니다'}).click();
    else if(!await page.locator('input[name=code]').count())throw Error('Device verification page: '+JSON.stringify({path:new URL(page.url()).pathname,status:verificationResponse?.status(),html:(await page.content()).slice(0,1500)}));
  }else{
    await page.evaluate(flow=>sessionStorage.setItem('g2_login_attempt',JSON.stringify(flow)),{verifier,state,createdAt:Date.now()});
    const params=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',scope:'remoteagent:g2',resource:resource+'/api/v1',state,
      code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    await page.goto(resource+'/oauth/auth?'+params);
  }
  await page.locator('input[name=code]').fill(auth.issueLoginCode().code);
  if(deviceFlow){await page.getByRole('button',{name:'연결 허용'}).click();await page.getByRole('heading',{name:'연결 승인 완료'}).waitFor();await page.goto(origin);}
  else await Promise.all([page.waitForURL(redirect+'?**'),page.getByRole('button',{name:'연결 허용'}).click()]);
  const result=await page.evaluate(async({resource,redirect,clientId,device})=>{
    let tokens;
    if(device){
      const response=await fetch(resource+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:clientId,device_code:device.device_code,resource:resource+'/api/v1'})});
      tokens=await response.json();if(!response.ok)throw Error('Device exchange failed: '+JSON.stringify(tokens));
    }else{
    const callback=new URL(location.href),flow=JSON.parse(sessionStorage.getItem('g2_login_attempt'));
    if(!flow || flow.state!==callback.searchParams.get('state') || Date.now()-flow.createdAt>300000 || callback.searchParams.get('iss')!==resource+'/oauth')throw Error('Invalid callback');
    history.replaceState(null,'','/oauth/callback');
    try {
      const response=await fetch(resource+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,code:callback.searchParams.get('code'),code_verifier:flow.verifier,resource:resource+'/api/v1'})});
      tokens=await response.json();if(!response.ok)throw Error('Token exchange failed');
    } finally {sessionStorage.removeItem('g2_login_attempt');}
    }
    let oldRefresh;
    if(device){
      oldRefresh=tokens.refresh_token;
      if(!oldRefresh)throw Error('Missing refresh token');
      const renewal=await fetch(resource+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:oldRefresh,resource:resource+'/api/v1'})});
      tokens=await renewal.json();if(!renewal.ok||!tokens.refresh_token||tokens.refresh_token===oldRefresh)throw Error('Refresh rotation failed');
    }
    const headers={authorization:'Bearer '+tokens.access_token,'content-type':'application/json'};
    const targetsResponse=await fetch(resource+'/api/v1/targets',{headers});
    if(!targetsResponse.ok)throw Error('Targets failed');const {targets}=await targetsResponse.json();
    const accepted=await fetch(resource+'/api/v1/requests',{method:'POST',headers,body:JSON.stringify({targetId:targets[0].targetId,clientRequestId:'browser-once',text:'synthetic browser test'})});
    if(accepted.status!==202)throw Error('Request acceptance failed');const request=await accepted.json();
    let snapshot;
    for(let i=0;i<20;i++){
      snapshot=await(await fetch(resource+'/api/v1/requests/'+request.requestId,{headers})).json();
      if(snapshot.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    const events=await(await fetch(resource+'/api/v1/requests/'+request.requestId+'/events?after=0',{headers})).json();
    let replayProtected=false;
    if(device){
      const refresh=token=>fetch(resource+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:token,resource:resource+'/api/v1'})});
      const replay=await refresh(oldRefresh),family=await refresh(tokens.refresh_token);
      replayProtected=replay.status===400&&family.status===400;if(!replayProtected)throw Error('Refresh replay did not revoke token family');
    }
    return {replayProtected,status:snapshot.status,text:snapshot.result?.text,eventTypes:events.events.map(event=>event.type),
      noRefresh:!tokens.refresh_token,sessionKeys:Object.keys(sessionStorage),localKeys:Object.keys(localStorage),query:location.search};
  },{resource,redirect,clientId,device});
  assert.equal(result.status,'completed');assert.equal(result.text,'browser final');assert.equal(result.noRefresh,!deviceFlow);assert.equal(result.replayProtected,deviceFlow);
  assert.deepEqual(result.sessionKeys,[]);assert.deepEqual(result.localKeys,[]);assert.equal(result.query,'');
  assert.ok(result.eventTypes.includes('progress'));assert.ok(result.eventTypes.includes('result'));
  console.log(JSON.stringify({ok:true,flow:deviceFlow?'device_code':'pkce',crossOriginTokenAndApi:true,accessTokenInMemory:true,refreshRotation:deviceFlow,requestAndEvents:true}));
} finally {
  await browser?.close();await mcp.close();
  for(const server of [proxy,ui]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  fs.rmSync(dir,{recursive:true,force:true});
}
