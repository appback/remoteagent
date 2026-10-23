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

const {chromium}=await import(process.env.PLAYWRIGHT_PACKAGE||'playwright');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g2-browser-'));
const keyFile=path.join(dir,'key.pem'),certFile=path.join(dir,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
const tls={key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)};
const ui=https.createServer(tls,(_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>G2 OAuth fixture</title><p>G2 OAuth test</p>'));
let backendPort;
const proxy=https.createServer(tls,(req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,
    headers:{...req.headers,'x-forwarded-proto':'https','x-forwarded-host':new URL(resource).host}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);
});
await new Promise(resolve=>ui.listen(0,'127.0.0.1',resolve));
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const origin=`https://127.0.0.1:${ui.address().port}`,resource=`https://127.0.0.1:${proxy.address().port}`;
const owner='telegram:g2-browser',clientId='remoteagent-g2-browser',redirect=origin+'/oauth/callback';
const dot=new DotBridgeService(dir,owner,async()=>{throw Error('No external webhook expected');});
const sessions={async listSessions(){return [{sessionId:'browser-session',publicId:'S001',mode:'codex',codex:{cwd:dir,pairedAt:new Date().toISOString()}}];},
  isSessionBusy(){return false;},isProviderAvailable(){return true;},
  async routeExternalMessage(_id,_provider,_text,_signal,started,progress){started();await progress({output:'browser progress'});return [{output:'browser final'}];}};
const requests=new G2RequestService(dir,owner,sessions,dot);await requests.restore();
const targets=await requests.inventory();
const client={clientId,origins:[origin],redirectUris:[redirect],targetIds:targets.map(target=>target.targetId)};
const auth=new DotOwnerAuthService(dir,resource,owner,[client]);
const api=new G2ApiService(requests,resource,[client],auth.authenticateG2.bind(auth));
const mcp=new DotMcpService(dot,'127.0.0.1',0,{resource,issuer:auth.issuer},auth.authenticate.bind(auth),auth.handle.bind(auth),undefined,undefined,api.handle.bind(api));
await mcp.start();backendPort=mcp.address().port;
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
  const page=await browser.newPage({ignoreHTTPSErrors:true});
  // Block everything except these two local TLS origins: no production credentials,
  // ChatGPT requests, Telegram calls or real G2 hardware are used by this fixture.
  await page.route('**/*',route=>[origin,resource].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  const verifier=randomBytes(48).toString('base64url'),state=randomBytes(24).toString('base64url');
  await page.goto(origin);
  await page.evaluate(flow=>sessionStorage.setItem('g2_login_attempt',JSON.stringify(flow)),{verifier,state,createdAt:Date.now()});
  const params=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',scope:'remoteagent:g2',resource:resource+'/api/v1',state,
    code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  await page.goto(resource+'/oauth/auth?'+params);
  await page.locator('input[name=code]').fill(auth.issueLoginCode().code);
  await Promise.all([page.waitForURL(redirect+'?**'),page.getByRole('button',{name:'연결 허용'}).click()]);
  const result=await page.evaluate(async({resource,redirect,clientId})=>{
    const callback=new URL(location.href),flow=JSON.parse(sessionStorage.getItem('g2_login_attempt'));
    if(!flow || flow.state!==callback.searchParams.get('state') || Date.now()-flow.createdAt>300000 || callback.searchParams.get('iss')!==resource+'/oauth')throw Error('Invalid callback');
    history.replaceState(null,'','/oauth/callback');
    let tokens;
    try {
      const response=await fetch(resource+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,code:callback.searchParams.get('code'),code_verifier:flow.verifier,resource:resource+'/api/v1'})});
      tokens=await response.json();if(!response.ok)throw Error('Token exchange failed');
    } finally {sessionStorage.removeItem('g2_login_attempt');}
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
    return {status:snapshot.status,text:snapshot.result?.text,eventTypes:events.events.map(event=>event.type),
      noRefresh:!tokens.refresh_token,sessionKeys:Object.keys(sessionStorage),localKeys:Object.keys(localStorage),query:location.search};
  },{resource,redirect,clientId});
  assert.equal(result.status,'completed');assert.equal(result.text,'browser final');assert.equal(result.noRefresh,true);
  assert.deepEqual(result.sessionKeys,[]);assert.deepEqual(result.localKeys,[]);assert.equal(result.query,'');
  assert.ok(result.eventTypes.includes('progress'));assert.ok(result.eventTypes.includes('result'));
  console.log(JSON.stringify({ok:true,realBrowserPkce:true,crossOriginTokenAndApi:true,callbackStateAndIssuer:true,memoryOnlyToken:true,requestAndEvents:true}));
} finally {
  await browser?.close();await mcp.close();
  for(const server of [proxy,ui]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  fs.rmSync(dir,{recursive:true,force:true});
}
