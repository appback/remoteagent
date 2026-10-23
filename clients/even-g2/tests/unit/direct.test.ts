import { describe, it, expect, vi, afterEach } from 'vitest';
import { OAuth, ISSUER, RESOURCE, FLOW_KEY, liveConfig } from '../../src/direct/oauth';
import { RemoteAPI, retryAt, validateSubmission } from '../../src/direct/api';
import { Tracker, CHECKPOINT_KEY } from '../../src/direct/tracker';
import { APIError, type RequestAPI, type Target, type Snapshot, type Page } from '../../src/direct/types';
class StorageFake implements Storage {
  values = new Map<string,string>(); get length(){return this.values.size;} clear(){this.values.clear();} getItem(k:string){return this.values.get(k)??null;} setItem(k:string,v:string){this.values.set(k,v);} removeItem(k:string){this.values.delete(k);} key(i:number){return [...this.values.keys()][i]??null;}
}
const cfg = liveConfig({ mode:'live', appOrigin:'https://client.test', callbackUrl:'https://client.test/oauth/callback', clientId:'remoteagent-g2-test' });
const json = (v:unknown,status=200,headers={}) => new Response(JSON.stringify(v),{status,headers});
const meta = { issuer:ISSUER, authorization_endpoint:ISSUER+'/auth', token_endpoint:ISSUER+'/token', code_challenge_methods_supported:['S256'] };
const token = { access_token:'FAKE_TEST_TOKEN',token_type:'Bearer',expires_in:3600,scope:'remoteagent:g2' };
function authFixture() {
 const storage=new StorageFake(), request=vi.fn<typeof fetch>().mockImplementation(async input=>String(input).endsWith('openid-configuration')?json(meta):json(token));
 const oauth=new OAuth(cfg,storage,request);return {storage,request,oauth};
}
async function callback(f:ReturnType<typeof authFixture>,extra:object={}) { const url=new URL(await f.oauth.authorize()); return cfg.callbackUrl+'?'+new URLSearchParams({code:'FAKE_CODE',state:url.searchParams.get('state')!,iss:ISSUER,...extra}); }
afterEach(()=>vi.useRealTimers());
describe('OAuth PKCE, memory-only tokens and clean callback',()=>{
 it('stores only state/verifier/time and uses S256, exact resource, no refresh scope',async()=>{
  const f=authFixture(),url=new URL(await f.oauth.authorize()),saved=JSON.parse(f.storage.getItem(FLOW_KEY)!);
  expect(Object.keys(saved).sort()).toEqual(['createdAt','state','verifier']); expect(saved.verifier).toHaveLength(43);
  const expected=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(saved.verifier))).toString('base64url');
  expect(url.searchParams.get('code_challenge')).toBe(expected);expect(url.searchParams.get('scope')).toBe('remoteagent:g2');expect(url.searchParams.get('resource')).toBe(RESOURCE);f.oauth.cancelLogin();
 });
 it('cleans history before form exchange, deletes flow, holds token only in memory',async()=>{
  const f=authFixture(),href=await callback(f),replace=vi.fn();
  f.request.mockImplementationOnce(async(_url,init)=>{expect(replace).toHaveBeenCalledWith('/oauth/callback');expect(f.storage.length).toBe(0);expect(init?.credentials).toBe('omit');expect(init?.headers).toEqual({'Content-Type':'application/x-www-form-urlencoded'});const form=new URLSearchParams(String(init?.body));expect(form.get('grant_type')).toBe('authorization_code');expect(form.get('resource')).toBe(RESOURCE);expect(form.has('client_secret')).toBe(false);return json(token);});
  expect(await f.oauth.callback(href,replace)).toBe(true);expect(f.oauth.token()).toBe(token.access_token);expect(f.storage.length).toBe(0);f.oauth.clear();
 });
 it.each([{state:'forged'},{iss:'https://evil.test/oauth'},{error:'access_denied'},{code:''}])('rejects forged/canceled callback %j before token call',async extra=>{
  const f=authFixture(),href=await callback(f,extra),replace=vi.fn();await expect(f.oauth.callback(href,replace)).rejects.toThrow('LOGIN_FAILED');expect(replace).toHaveBeenCalled();expect(f.storage.length).toBe(0);expect(f.request).toHaveBeenCalledTimes(1);expect(()=>f.oauth.token()).toThrow('LOGIN_REQUIRED');
 });
 it('rejects duplicate state and incorrect callback path',async()=>{
  for(const change of [(s:string)=>s+'&state=second',(s:string)=>s.replace('/oauth/callback','/other')]) {const f=authFixture();await expect(f.oauth.callback(change(await callback(f)),vi.fn())).rejects.toThrow();expect(f.storage.length).toBe(0);}
 });
 it('rejects five-minute expiry and future timestamp, deletes flow',async()=>{
  for(const delta of [-300000,1000]) {const f=authFixture(),href=await callback(f),flow=JSON.parse(f.storage.getItem(FLOW_KEY)!);flow.createdAt=Date.now()+delta;f.storage.setItem(FLOW_KEY,JSON.stringify(flow));await expect(f.oauth.callback(href,vi.fn())).rejects.toThrow();expect(f.storage.length).toBe(0);}
 });
 it('removes flow after failed token exchange; no mock fallback',async()=>{
  const f=authFixture(),href=await callback(f);f.request.mockResolvedValueOnce(json({error:'invalid_grant'},400));await expect(f.oauth.callback(href,vi.fn())).rejects.toThrow();expect(f.storage.length).toBe(0);expect(()=>f.oauth.token()).toThrow();
 });
 it('requires login after reload and expires before the server last-minute cutoff',async()=>{
  vi.useFakeTimers();const f=authFixture();await f.oauth.callback(await callback(f),vi.fn());const reloaded=new OAuth(cfg,f.storage,f.request);expect(()=>reloaded.token()).toThrow();await vi.advanceTimersByTimeAsync(3540000);expect(()=>f.oauth.token()).toThrow();expect(f.storage.length).toBe(0);
 });
 it('cancels login and rejects metadata issuer substitution',async()=>{
  const f=authFixture();await f.oauth.authorize();f.oauth.cancelLogin();expect(f.storage.length).toBe(0);f.request.mockResolvedValueOnce(json({...meta,issuer:'https://evil.test'}));await expect(f.oauth.authorize()).rejects.toThrow('OAUTH_METADATA_INVALID');expect(f.storage.length).toBe(0);
 });
 it('prunes stale login attempts on reload without any network',()=>{
  const f=authFixture();f.storage.setItem(FLOW_KEY,JSON.stringify({state:'old',verifier:'v',createdAt:0}));new OAuth(cfg,f.storage,f.request);expect(f.storage.length).toBe(0);expect(f.request).not.toHaveBeenCalled();
 });
});
const target:Target={targetId:'tgt_test',provider:'codex',type:'session',label:'test',available:true,cancelMode:'execution'};
const input={targetId:target.targetId,clientRequestId:'same-id',text:'hello'};
const receipt=(v=input):Snapshot=>({...v,requestId:'req_test',status:'accepted',lastSeq:1});
function apiFixture(){const auth={token:vi.fn(()=>token.access_token),clear:vi.fn()},request=vi.fn<typeof fetch>();return {auth,request,api:new RemoteAPI(auth,request)};}
describe('REST boundary and rate limits',()=>{
 it('uses exact audience paths, bearer and omit credentials',async()=>{const f=apiFixture();f.request.mockResolvedValue(json(receipt()));await f.api.submit(input);expect(f.request.mock.calls[0][0]).toBe(RESOURCE+'/requests');const init=f.request.mock.calls[0][1]!;expect(init.credentials).toBe('omit');expect(init.redirect).toBe('error');expect(init.headers).toMatchObject({Authorization:'Bearer '+token.access_token});expect(JSON.parse(String(init.body))).toEqual(input);});
 it('clears credentials on 401 and does not retry submission',async()=>{const f=apiFixture();f.request.mockResolvedValue(json({error:'UNAUTHORIZED'},401));await expect(f.api.submit(input)).rejects.toMatchObject({status:401});expect(f.auth.clear).toHaveBeenCalledTimes(1);expect(f.request).toHaveBeenCalledTimes(1);});
 it('enforces UTF8 text and total JSON byte limits',()=>{expect(()=>validateSubmission({...input,text:'가'.repeat(10923)})).toThrow();expect(()=>validateSubmission({...input,text:'"'.repeat(32768)})).toThrow();expect(()=>validateSubmission({...input,text:'a'.repeat(32768)})).not.toThrow();});
 it('obeys seconds/date Retry-After globally without issuing early requests',async()=>{vi.useFakeTimers();const f=apiFixture();f.request.mockResolvedValueOnce(json({},429,{'Retry-After':'6'})).mockResolvedValue(json({targets:[target]}));await expect(f.api.targets()).rejects.toMatchObject({status:429});await expect(f.api.targets()).rejects.toMatchObject({status:429});expect(f.request).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(6000);expect(await f.api.targets()).toEqual([target]);const now=Date.now();expect(retryAt(new Date(now+9000).toUTCString(),now)).toBe(Math.floor((now+9000)/1000)*1000);});
 it('rejects mismatched receipt and unsupported targets',async()=>{const f=apiFixture();f.request.mockResolvedValueOnce(json({...receipt(),targetId:'tgt_other'})).mockResolvedValueOnce(json({targets:[{...target,provider:'other'}]}));await expect(f.api.submit(input)).rejects.toThrow('CORRELATION');await expect(f.api.targets()).rejects.toThrow('INVALID_TARGET');});
 it('does not trust invalid event sequences or request identity',async()=>{const f=apiFixture();f.request.mockResolvedValue(json({requestId:'req_wrong',events:[],nextCursor:1,hasMore:false,status:'running'}));await expect(f.api.events('req_test',0)).rejects.toThrow('INVALID_EVENTS');});
});
function trackerFixture(){const storage=new StorageFake();const api:RequestAPI={targets:vi.fn(async()=>[target]),submit:vi.fn(async v=>receipt(v)),snapshot:vi.fn(async()=>receipt()),events:vi.fn(async id=>({requestId:id,events:[],nextCursor:0,hasMore:false,status:'running' as const})),cancel:vi.fn(async()=>({...receipt(),status:'cancel_requested' as const}))};const tracker=new Tracker(api,storage);tracker.select(target);return {storage,api,tracker};}
function state(f:ReturnType<typeof trackerFixture>,overrides:Partial<Snapshot>={}):Snapshot{return {...receipt(),clientRequestId:f.tracker.work!.clientRequestId,...overrides};}
describe('request lifecycle with fake API',()=>{
 it('deduplicates concurrent clicks and polls no sooner than three seconds',async()=>{vi.useFakeTimers();const f=trackerFixture();await Promise.all([f.tracker.send('hello'),f.tracker.send('hello')]);expect(f.api.submit).toHaveBeenCalledTimes(1);expect(f.tracker.work?.status).toBe('accepted');expect(f.tracker.work?.seq).toBe(0);await vi.advanceTimersByTimeAsync(2999);expect(f.api.events).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(f.api.events).toHaveBeenCalledTimes(1);f.tracker.pause();});
 it('preserves payload/id across timeouts and rejects changed text',async()=>{const f=trackerFixture();vi.mocked(f.api.submit).mockRejectedValueOnce(Error('timeout'));await expect(f.tracker.send('hello')).rejects.toThrow();const id=f.tracker.work!.clientRequestId;await expect(f.tracker.send('changed')).rejects.toThrow('IDENTICAL');await f.tracker.send('hello');expect(f.tracker.work?.clientRequestId).toBe(id);expect(vi.mocked(f.api.submit).mock.calls[0][0]).toEqual(vi.mocked(f.api.submit).mock.calls[1][0]);f.tracker.pause();});
 it('persists no token/text and restores pending identical-text retry after reload',async()=>{const f=trackerFixture();vi.mocked(f.api.submit).mockRejectedValueOnce(Error('timeout'));await expect(f.tracker.send('private sentence')).rejects.toThrow();const saved=f.storage.getItem(CHECKPOINT_KEY)!;expect(saved).not.toContain('private sentence');expect(saved).not.toContain('token');const reload=new Tracker(f.api,f.storage);reload.select(target);await expect(reload.send('different')).rejects.toThrow();await reload.send('private sentence');expect(vi.mocked(f.api.submit).mock.calls[1][0].clientRequestId).toBe(f.tracker.work?.clientRequestId);reload.pause();f.tracker.pause();});
 it('processes duplicate events once, follows hasMore immediately and separates unknown outcome',async()=>{vi.useFakeTimers();const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockResolvedValueOnce({requestId:'req_test',events:[{seq:1,type:'accepted'},{seq:2,type:'progress',text:'working'}],nextCursor:999,hasMore:true,status:'running'}).mockResolvedValueOnce({requestId:'req_test',events:[{seq:2,type:'progress',text:'duplicate'},{seq:3,type:'result',text:'done',outcome:'unknown'}],nextCursor:3,hasMore:false,status:'completed'});vi.mocked(f.api.snapshot).mockResolvedValue(state(f,{status:'completed',lastSeq:3,result:{text:'done',outcome:'unknown',truncated:false}}));await f.tracker.poll();expect(f.tracker.work?.seq).toBe(2);await vi.advanceTimersByTimeAsync(1);expect(vi.mocked(f.api.events).mock.calls[1][1]).toBe(2);expect(f.tracker.work?.progress).toEqual(['working']);expect(f.tracker.work?.result?.outcome).toBe('unknown');f.tracker.pause();});
 it('keeps only processed cursor when later events are out of order',async()=>{const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockResolvedValue({requestId:'req_test',events:[{seq:1,type:'accepted'},{seq:3,type:'progress',text:'gap'}],nextCursor:3,hasMore:false,status:'running'});await f.tracker.poll();expect(f.tracker.work?.seq).toBe(1);expect(JSON.parse(f.storage.getItem(CHECKPOINT_KEY)!)[0].seq).toBe(1);f.tracker.pause();});
 it('recovers 410 snapshot and lastSeq without submitting again',async()=>{const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockRejectedValueOnce(new APIError(410));vi.mocked(f.api.snapshot).mockResolvedValue(state(f,{status:'completed',lastSeq:50,result:{text:'final',outcome:'unknown',truncated:false}}));await f.tracker.poll();expect(f.tracker.work?.seq).toBe(50);expect(f.tracker.work?.result?.text).toBe('final');expect(f.api.submit).toHaveBeenCalledTimes(1);f.tracker.pause();});
 it('restores requestId and processed seq on reconnect after reload',async()=>{const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockResolvedValue({requestId:'req_test',events:[{seq:1,type:'accepted'}],nextCursor:1,hasMore:false,status:'running'});await f.tracker.poll();f.tracker.pause();const reload=new Tracker(f.api,f.storage);reload.select(target);await reload.poll();expect(vi.mocked(f.api.events).mock.calls.at(-1)?.slice(0,2)).toEqual(['req_test',1]);expect(f.api.submit).toHaveBeenCalledTimes(1);reload.pause();});
 it('ignores late replies after selecting another target',async()=>{const f=trackerFixture();await f.tracker.send('hello');let resolve!:(v:Page)=>void;vi.mocked(f.api.events).mockImplementationOnce(()=>new Promise(r=>resolve=r));const pending=f.tracker.poll();f.tracker.select({...target,targetId:'tgt_other',provider:'claude'});resolve({requestId:'req_test',events:[{seq:1,type:'result',text:'old'}],nextCursor:1,hasMore:false,status:'completed'});await pending;expect(f.tracker.work).toBeUndefined();f.tracker.select(target);expect(f.tracker.work?.seq).toBe(0);f.tracker.pause();});
 it('honors 429 polling delay and stops on 401',async()=>{vi.useFakeTimers();const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockRejectedValueOnce(new APIError(429,Date.now()+7000)).mockRejectedValueOnce(new APIError(401));await f.tracker.poll();await vi.advanceTimersByTimeAsync(6999);expect(f.api.events).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(f.api.events).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(9000);expect(f.api.events).toHaveBeenCalledTimes(2);f.tracker.pause();});
 it('keeps cancel_requested distinct from confirmed delivery-only cancellation',async()=>{const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.cancel).mockResolvedValueOnce(state(f,{status:'cancel_requested' as const})).mockResolvedValueOnce(state(f,{status:'canceled',cancel:{scope:'delivery_only',confirmed:true,executionStopped:false}}));await f.tracker.cancel();expect(f.tracker.work?.status).toBe('cancel_requested');expect(f.tracker.work?.cancel).toBeUndefined();await f.tracker.cancel();expect(f.tracker.work?.cancel?.executionStopped).toBe(false);f.tracker.pause();});
 it.each(['failed','interrupted','completed'] as const)('does not replay a terminal %s request',async status=>{const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockResolvedValue({requestId:'req_test',events:[],nextCursor:0,hasMore:false,status});vi.mocked(f.api.snapshot).mockResolvedValue(state(f,{status}));await f.tracker.poll();expect(f.tracker.work?.status).toBe(status);expect(f.api.submit).toHaveBeenCalledTimes(1);f.tracker.pause();});
});
describe('additional cancellation and restoration races',()=>{
 it('cannot restore a token when logout happens during exchange',async()=>{
  const f=authFixture(),href=await callback(f);let resolve!:(v:Response)=>void;
  f.request.mockImplementationOnce(()=>new Promise(r=>resolve=r));const pending=expect(f.oauth.callback(href,vi.fn())).rejects.toThrow('LOGIN_FAILED');
  f.oauth.clear();resolve(json(token));await pending;expect(()=>f.oauth.token()).toThrow();expect(f.storage.length).toBe(0);
 });
 it('ignores late terminal snapshot after switching targets',async()=>{
  const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockResolvedValue({requestId:'req_test',events:[],nextCursor:0,hasMore:false,status:'completed'});
  let resolve!:(v:Snapshot)=>void;vi.mocked(f.api.snapshot).mockImplementationOnce(()=>new Promise(r=>resolve=r));const work=f.tracker.poll();await Promise.resolve();
  const old=state(f,{status:'completed',result:{text:'old',outcome:'unknown',truncated:false}});f.tracker.select({...target,targetId:'tgt_new'});resolve(old);await work;expect(f.tracker.work).toBeUndefined();f.tracker.select(target);expect(f.tracker.work?.status).toBe('accepted');f.tracker.pause();
 });
 it('shows execution-scope confirmation without claiming rollback',async()=>{
  const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.cancel).mockResolvedValue(state(f,{status:'canceled',cancel:{scope:'execution',confirmed:true,executionStopped:true}}));await f.tracker.cancel();expect(f.tracker.work?.cancel).toEqual({scope:'execution',confirmed:true,executionStopped:true});f.tracker.pause();
 });
 it('creates a new ID only for an explicit new request after a terminal state',async()=>{
  const f=trackerFixture();await f.tracker.send('hello');const old=f.tracker.work!.clientRequestId;
  vi.mocked(f.api.cancel).mockResolvedValue(state(f,{status:'canceled'}));await f.tracker.cancel();await f.tracker.send('intentionally new');expect(f.tracker.work?.clientRequestId).not.toBe(old);f.tracker.pause();
 });
 it('stops automatic polling after target access is withdrawn',async()=>{
  vi.useFakeTimers();const f=trackerFixture();await f.tracker.send('hello');vi.mocked(f.api.events).mockRejectedValue(new APIError(403));await f.tracker.poll();await vi.advanceTimersByTimeAsync(10000);expect(f.api.events).toHaveBeenCalledTimes(1);f.tracker.pause();
 });
});
