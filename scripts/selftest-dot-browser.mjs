import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {DotOwnerAuthService} from '../dist/services/dot-owner-auth-service.js';
import {DotBridgeService} from '../dist/services/dot-bridge-service.js';
import {DotMcpService} from '../dist/services/dot-mcp-service.js';

const {chromium}=await import(process.env.PLAYWRIGHT_PACKAGE||'playwright');
const owner='telegram:browser-test',redirect='https://chatgpt.com/connector_platform_oauth_redirect';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-browser-'));
const keyFile=path.join(dir,'tls.key'),certFile=path.join(dir,'tls.crt');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
let backendPort;
const proxy=https.createServer({key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)},(req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,
    headers:{...req.headers,'x-forwarded-proto':'https','x-forwarded-host':new URL(resource).host}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const resource=`https://127.0.0.1:${proxy.address().port}`;
const auth=new DotOwnerAuthService(dir,resource,owner);
const bridge=new DotBridgeService(dir,owner,async()=>{throw Error('Unexpected webhook');});
const mcp=new DotMcpService(bridge,'127.0.0.1',0,{resource,issuer:auth.issuer},auth.authenticate.bind(auth),auth.handle.bind(auth));
await mcp.start();
const base=`http://127.0.0.1:${mcp.address().port}`;
backendPort=mcp.address().port;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}),
    ...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
  const page=await browser.newPage({ignoreHTTPSErrors:true});const formOrigins=[];
  page.on('request',async req=>{if(req.method()==='POST')formOrigins.push((await req.allHeaders()).origin);});
  // Observe the callback request but block its network connection, so no fake
  // authorization code leaves this local HTTPS test.
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Network.setBlockedURLs',{urls:['https://chatgpt.com/*']});
  const verifier=randomBytes(48).toString('base64url');
  const params=new URLSearchParams({client_id:'remoteagent-dot',redirect_uri:redirect,response_type:'code',scope:'openid offline_access remoteagent:dot',resource,state:'browser-test',
    code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  await page.goto(resource+'/oauth/auth?'+params,{waitUntil:'domcontentloaded'});
  await page.locator('input[name=code]').fill(auth.issueLoginCode().code);
  const callbackRequest=page.waitForRequest(r=>r.url().startsWith(redirect+'?'),{timeout:10000});
  void callbackRequest.catch(()=>undefined);
  const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'),page.getByRole('button',{name:'연결 허용'}).click({noWaitAfter:true})]);
  assert.equal(response.status(),303,response.status()===303?undefined:await response.text());
  const callback=new URL((await callbackRequest).url());
  assert.ok(callback?.searchParams.get('code'));
  assert.equal(callback.searchParams.get('iss'),auth.issuer);
  assert.deepEqual(formOrigins,[resource],'browser must preserve the exact origin, not null');
  const tokenResponse=await fetch(base+'/oauth/token',{method:'POST',headers:{'x-forwarded-proto':'https','x-forwarded-host':new URL(resource).host,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',client_id:'remoteagent-dot',redirect_uri:redirect,resource,code:callback.searchParams.get('code'),code_verifier:verifier})});
  assert.equal(tokenResponse.status,200,await tokenResponse.clone().text());
  const tokens=await tokenResponse.json();assert.equal((await auth.authenticate('Bearer '+tokens.access_token))?.subject,owner);
  console.log(JSON.stringify({ok:true,realBrowserApproval:true,originPreserved:true,cookiesAndCsrf:true,pkceTokenExchange:true}));
}finally{await browser?.close();await mcp.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
