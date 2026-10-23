import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {DotOwnerAuthService, DotAuthStore, isChatGptClient} from '../dist/services/dot-owner-auth-service.js';
import {DotMcpService} from '../dist/services/dot-mcp-service.js';
import {DotBridgeService} from '../dist/services/dot-bridge-service.js';

const resource = 'https://bridge.example.test';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const owner = 'telegram:123456';
const scope = 'openid offline_access remoteagent:dot';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-owner-oauth-'));
  const auth = new DotOwnerAuthService(dir, resource, owner);
  const prompts=[];auth.provider.on('interaction.started',(_ctx,prompt)=>prompts.push(prompt));
  const bridge = new DotBridgeService(dir, owner, async()=>{throw Error('no outgoing requests');});
  const mcp = new DotMcpService(bridge,'127.0.0.1',0,{resource,issuer:auth.issuer},auth.authenticate.bind(auth),auth.handle.bind(auth));
  await mcp.start();
  t.after(async()=>{await mcp.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${mcp.address().port}`;
  const cookies = new Map();
  async function request(url, options={}) {
    const target = new URL(url, resource);
    const result = await fetch(base+target.pathname+target.search, {...options,redirect:'manual',headers:{
      host:'bridge.example.test','x-forwarded-host':'bridge.example.test','x-forwarded-proto':'https',cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...options.headers,
    }});
    for(const c of result.headers.getSetCookie()){const [name,value]=c.split(';')[0].split('=');cookies.set(name,value);}
    return result;
  }
  async function begin(challenge) {
    const params = new URLSearchParams({client_id:'remoteagent-dot',redirect_uri:redirect,response_type:'code',
      scope,resource,state:'test-state',code_challenge:challenge,code_challenge_method:'S256',prompt:'consent'});
    const response = await request('/oauth/auth?'+params);
    assert.equal(response.status,303,await response.text());
    const location = response.headers.get('location');
    const page = await request(location);
    assert.equal(page.status,200,await page.clone().text());
    assert.equal(page.headers.get('referrer-policy'),'same-origin','approval form must preserve the browser Origin header');
    assert.ok(page.headers.get('content-security-policy').includes("form-action 'self' https://chatgpt.com/connector_platform_oauth_redirect https://chatgpt.com/connector/oauth/;"));
    const html = await page.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];assert.ok(csrf);
    return {location,csrf};
  }
  return {dir,auth,bridge,mcp,request,begin,prompts};
}
function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return {verifier,challenge:createHash('sha256').update(verifier).digest('base64url')};
}
async function approve(f, flow, code, overrides={}) {
  return f.request(flow.location,{method:'POST',headers:{origin:resource,'content-type':'application/x-www-form-urlencoded',...overrides.headers},
    body:new URLSearchParams({csrf:flow.csrf,code,...overrides.body})});
}
async function exchange(f, verifier, approvalCode) {
  const {challenge} = {challenge:createHash('sha256').update(verifier).digest('base64url')};
  const flow = await f.begin(challenge);
  let response = await approve(f,flow,approvalCode);
  for(let i=0;i<8;i++) {
    assert.ok([302,303].includes(response.status),JSON.stringify(f.prompts));
    const location = response.headers.get('location');assert.ok(location);
    if(location.startsWith(redirect)) {
      const callback = new URL(location);assert.equal(callback.searchParams.get('state'),'test-state');
      assert.equal(callback.searchParams.get('iss'),f.auth.issuer);
      const code = callback.searchParams.get('code');assert.ok(code,location);
      return {code, token:async(verifierValue=verifier)=>f.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'authorization_code',client_id:'remoteagent-dot',redirect_uri:redirect,code,resource,code_verifier:verifierValue})})};
    }
    response = await f.request(location);
  }
  assert.fail('OAuth did not return to ChatGPT');
}

test('only approved ChatGPT client metadata URLs are fetched',()=>{
  for(const id of ['remoteagent-dot','https://chatgpt.com/oauth/client.json','https://chatgpt.com/oauth/abc_123/client.json'])assert.equal(isChatGptClient(id),true);
  for(const id of ['https://chatgpt.com.evil.test/oauth/client.json','https://chatgpt.com@evil.test/oauth/client.json','http://chatgpt.com/oauth/client.json','https://127.0.0.1/client.json','https://chatgpt.com/oauth/client.json?x=1'])assert.equal(isChatGptClient(id),false);
});
test('OAuth metadata is live; protected MCP requires authentication',async t=>{
  const f=await fixture(t);
  const r=await f.request('/oauth/.well-known/openid-configuration');assert.equal(r.status,200);
  const metadata=await r.json();assert.equal(metadata.issuer,f.auth.issuer);assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.equal(metadata.client_id_metadata_document_supported,true);
  const denied=await f.request('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,401);
  assert.match(denied.headers.get('www-authenticate'),/oauth-protected-resource/);
});
test('full real-library PKCE exchange, authenticated tools, refresh and restart continuity',async t=>{
  const f=await fixture(t),{verifier}=pkce();
  const {code}=f.auth.issueLoginCode();const flow=await exchange(f,verifier,code);
  const response=await flow.token();assert.equal(response.status,200,await response.clone().text());
  const tokens=await response.json();assert.ok(tokens.access_token);assert.ok(tokens.refresh_token);
  const saved=await f.auth.provider.AccessToken.find(tokens.access_token);
  assert.equal((await f.auth.authenticate('Bearer '+tokens.access_token))?.subject,owner,JSON.stringify({scope:saved?.scope,aud:saved?.aud,accountId:saved?.accountId,expiration:saved?.expiration,isExpired:saved?.isExpired,grantId:!!saved?.grantId,grantFound:!!(saved&&await f.auth.provider.Grant.find(saved.grantId))}));
  const restarted=new DotOwnerAuthService(f.dir,resource,owner);
  assert.equal((await restarted.authenticate('Bearer '+tokens.access_token))?.subject,owner);
  const tools=await f.request('/mcp',{method:'POST',headers:{authorization:'Bearer '+tokens.access_token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(tools.status,200);assert.equal((await tools.json()).result.tools.length,4);
  const refresh=await f.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:'remoteagent-dot',resource,refresh_token:tokens.refresh_token})});
  assert.equal(refresh.status,200,await refresh.clone().text());assert.ok((await refresh.json()).access_token);
  const grant=await f.auth.provider.Grant.find(saved.grantId);await grant.destroy();
  assert.equal(await f.auth.authenticate('Bearer '+tokens.access_token),undefined,'revoked grant must deny existing tokens');
  assert.equal((await flow.token()).status,400,'authorization code must not be reusable');
  assert.equal(fs.statSync(path.join(f.dir,'dot/auth/oauth-records.json')).mode&0o777,0o600);
});
test('approval requires browser cookie, origin, CSRF and owner code; code cannot be replayed',async t=>{
  const f=await fixture(t),{challenge,verifier}=pkce();
  const flow=await f.begin(challenge);const {code}=f.auth.issueLoginCode();
  assert.equal((await approve(f,flow,'invalid')).status,403);
  assert.equal((await approve(f,flow,code,{headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await approve(f,flow,code,{body:{csrf:'invalid'}})).status,403);
  const response=await approve(f,flow,code);assert.equal(response.status,303,await response.text());
  const other=await f.begin(challenge);assert.equal((await approve(f,other,code)).status,403);
  const fresh=f.auth.issueLoginCode();const exchangeFlow=await exchange(f,verifier,fresh.code);
  assert.equal((await exchangeFlow.token('incorrect-verifier')).status,400);
});
test('adapter persists consumption and revocation, rejects owner/issuer changes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new DotAuthStore(dir).adapter('AccessToken');await a.upsert('a',{grantId:'g',uid:'u'},3600);await a.consume('a');
  const b=new DotAuthStore(dir).adapter('AccessToken');assert.ok((await b.find('a')).consumed);assert.ok(await b.findByUid('u'));
  await b.revokeByGrantId('g');assert.equal(await b.find('a'),undefined);
  new DotOwnerAuthService(dir,resource,owner);
  assert.throws(()=>new DotOwnerAuthService(dir,resource,'another-owner'),/IDENTITY_CHANGED/);
  assert.throws(()=>new DotOwnerAuthService(dir,'https://another.example.test',owner),/IDENTITY_CHANGED/);
  assert.throws(()=>new DotOwnerAuthService(dir,'http://localhost',owner),/INVALID_ORIGIN/);
});

test('expired approval codes and interactions without the browser cookie are rejected',async t=>{
  const f=await fixture(t),{challenge}=pkce();
  const {code}=f.auth.issueLoginCode();
  // Simulate only the credential expiring, without making the OAuth interaction expire.
  for(const value of f.auth.codes.values())value.expires=Date.now()-1;
  const flow=await f.begin(challenge);
  assert.equal((await approve(f,flow,code)).status,403);
  const fresh=f.auth.issueLoginCode();
  assert.equal((await approve(f,flow,fresh.code,{headers:{cookie:''}})).status,400);
  assert.equal((await approve(f,flow,fresh.code)).status,303);
});
