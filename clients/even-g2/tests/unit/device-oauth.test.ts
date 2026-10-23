import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeviceOAuth } from '../../src/direct/device-oauth';
import { ISSUER } from '../../src/direct/oauth';
afterEach(() => { vi.useRealTimers(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const start = { device_code: 'x'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: ISSUER + '/device', expires_in: 300, interval: 5 };
const token = { access_token: 'synthetic-token', token_type: 'Bearer', scope: 'remoteagent:g2', expires_in: 3600, refresh_token:'synthetic-refresh-token-12345' };
describe('device login', () => {
  it('polls pending and slow_down at required intervals; token only usable until expiry', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(response(start)).mockResolvedValueOnce(response({error:'authorization_pending'},400)).mockResolvedValueOnce(response({error:'slow_down'},400)).mockResolvedValueOnce(response(token));
    const auth = new DeviceOAuth('remoteagent-g2-even', request), show = vi.fn();
    const work = auth.login(show); await vi.advanceTimersByTimeAsync(0);expect(show.mock.calls[0][0].userCode).toBe(start.user_code);
    await vi.advanceTimersByTimeAsync(5000);expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9999);expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);await work;expect(auth.token()).toBe(token.access_token);expect(show).toHaveBeenLastCalledWith(null);
    const body = request.mock.calls[3][1].body as URLSearchParams;expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(request.mock.calls[3][1].credentials).toBe('omit');
    await vi.advanceTimersByTimeAsync(3540000);expect(auth.token()).toBe(token.access_token);auth.clear();
  });
  it('cancel during pending response prevents late token adoption', async () => {
    vi.useFakeTimers(); let resolve!: (r:Response)=>void;
    const request=vi.fn().mockResolvedValueOnce(response(start)).mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;}));
    const auth=new DeviceOAuth('remoteagent-g2-even',request); const work=auth.login(()=>{}); const failure=expect(work).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000); auth.cancelLogin(); resolve(response(token)); await failure;expect(()=>auth.token()).toThrow();
  });
  it.each(['access_denied','expired_token'])('fails closed on %s', async error => {
    vi.useFakeTimers();const request=vi.fn().mockResolvedValueOnce(response(start)).mockResolvedValueOnce(response({error},400));
    const auth=new DeviceOAuth('remoteagent-g2-even',request);const work=auth.login(()=>{});const failure=expect(work).rejects.toThrow();await vi.advanceTimersByTimeAsync(5000);await failure;expect(()=>auth.token()).toThrow();
  });
  it('rejects foreign verification URI before showing it',async()=>{
    const auth=new DeviceOAuth('remoteagent-g2-even',vi.fn().mockResolvedValue(response({...start,verification_uri:'https://evil.test'})));const show=vi.fn();await expect(auth.login(show)).rejects.toThrow('INVALID_DEVICE_RESPONSE');expect(show.mock.calls.every(([v])=>v===null)).toBe(true);
  });
  it('rejects missing refresh tokens',async()=>{
    vi.useFakeTimers();const request=vi.fn().mockResolvedValueOnce(response(start)).mockResolvedValueOnce(response({...token,refresh_token:undefined}));
    const auth=new DeviceOAuth('remoteagent-g2-even',request);const work=auth.login(()=>{});const failure=expect(work).rejects.toThrow('INVALID_TOKEN_RESPONSE');await vi.advanceTimersByTimeAsync(5000);await failure;expect(()=>auth.token()).toThrow();
  });
});

describe('automatic renewal and restoration',()=>{
 const store=()=>{let value='';return {read:vi.fn(async()=>value),write:vi.fn(async(v:string)=>{value=v;})};};
 async function signedIn(storage=store()){
  vi.useFakeTimers();const request=vi.fn().mockResolvedValueOnce(response(start)).mockResolvedValueOnce(response(token));
  const auth=new DeviceOAuth('remoteagent-g2-even',request,()=>{},Date.now,storage);
  const login=auth.login(()=>{});await vi.advanceTimersByTimeAsync(5000);await login;return {auth,request,storage};
 }
 it('renews before one hour and rotates only persisted refresh credentials',async()=>{
  const {auth,request,storage}=await signedIn();
  request.mockResolvedValueOnce(response({...token,access_token:'renewed',refresh_token:'rotated-refresh-token-12345'}));
  await vi.advanceTimersByTimeAsync(3300000);expect(await auth.getToken()).toBe('renewed');
  expect(storage.write).toHaveBeenLastCalledWith('rotated-refresh-token-12345');
  expect(JSON.stringify(storage.write.mock.calls)).not.toContain('renewed');auth.clear();
 });
 it('restores in a new app instance without a device-code login',async()=>{
  const {auth,storage}=await signedIn();const request=vi.fn().mockResolvedValue(response({...token,access_token:'restored'}));
  const reopened=new DeviceOAuth('remoteagent-g2-even',request,()=>{},Date.now,storage);
  expect(await reopened.restore()).toBe(true);expect(await reopened.getToken()).toBe('restored');
  expect((request.mock.calls[0] as any)[1].body.get('grant_type')).toBe('refresh_token');auth.clear();reopened.clear();
 });
 it('coalesces concurrent renewal requests',async()=>{
  const {auth,request}=await signedIn();let resolve!:(r:Response)=>void;
  request.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;}));
  await vi.advanceTimersByTimeAsync(3540000);const a=auth.getToken(),b=auth.getToken();expect(request).toHaveBeenCalledTimes(3);
  resolve(response({...token,access_token:'shared'}));expect(await a).toBe('shared');expect(await b).toBe('shared');auth.clear();
 });
 it('clears revoked refresh tokens and does not loop login',async()=>{
  const {auth,request,storage}=await signedIn();request.mockResolvedValueOnce(response({error:'invalid_grant'},400));
  await vi.advanceTimersByTimeAsync(3300000);expect(await storage.read()).toBe('');expect(()=>auth.token()).toThrow();
 });
 it('keeps connection across a transient network failure',async()=>{
  const {auth,request}=await signedIn();request.mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(response({...token,access_token:'back-online'}));
  await vi.advanceTimersByTimeAsync(3300000);expect(auth.token()).toBe(token.access_token);
  await vi.advanceTimersByTimeAsync(30000);expect(await auth.getToken()).toBe('back-online');auth.clear();
 });
 it('logout during renewal cannot restore a late credential',async()=>{
  const {auth,request,storage}=await signedIn();let resolve!:(r:Response)=>void;
  request.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;})).mockResolvedValueOnce(response({}));
  await vi.advanceTimersByTimeAsync(3300000);await auth.logout();resolve(response({...token,access_token:'late'}));await vi.advanceTimersByTimeAsync(0);
  expect(await storage.read()).toBe('');expect(()=>auth.token()).toThrow();
 });
 it('honors refresh Retry-After without clearing a still-valid token',async()=>{
  const {auth,request}=await signedIn();request.mockResolvedValueOnce(new Response('{}',{status:429,headers:{'Retry-After':'120'}})).mockResolvedValueOnce(response({...token,access_token:'after-limit'}));
  await vi.advanceTimersByTimeAsync(3300000);expect(auth.token()).toBe(token.access_token);await vi.advanceTimersByTimeAsync(119999);expect(request).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);expect(await auth.getToken()).toBe('after-limit');auth.clear();
 });
 it('does not claim login when host storage cannot persist refresh',async()=>{
  vi.useFakeTimers();const request=vi.fn().mockResolvedValueOnce(response(start)).mockResolvedValueOnce(response(token));
  const auth=new DeviceOAuth('remoteagent-g2-even',request,()=>{},Date.now,{async read(){return '';},async write(){throw Error('storage unavailable');}});
  const login=auth.login(()=>{});const failure=expect(login).rejects.toThrow('storage unavailable');await vi.advanceTimersByTimeAsync(5000);await failure;expect(()=>auth.token()).toThrow();
 });

});
