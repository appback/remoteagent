import { APIError, record } from './types';
import { ISSUER, RESOURCE } from './oauth';
export type DevicePrompt = { userCode: string; verificationUri: string; expiresAt: number };
export interface CredentialStore { read(): Promise<string>; write(value: string): Promise<void> }
function memoryStore(): CredentialStore { let value='';return {async read(){return value;},async write(v){value=v;}}; }
export class DeviceOAuth {
  #access = ''; #expires = 0; #refresh = '';
  private generation = 0;
  private retryAfter = 0;
  private renewal?: Promise<string>;
  private writes: Promise<void> = Promise.resolve();
  private controller?: AbortController;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(readonly clientId: string, private request: typeof fetch = fetch, private invalidated = () => {}, private now = Date.now, private storage: CredentialStore = memoryStore(), private connected = () => {}) {
    if (!/^remoteagent-g2-[a-z0-9_-]{1,48}$/.test(clientId)) throw Error('INVALID_CLIENT');
    const transport = request; this.request = (...args) => transport(...args);
  }
  private save(value: string) {
    const next=this.writes.catch(()=>{}).then(()=>this.storage.write(value));
    this.writes=next;return next;
  }
  clear() {
    this.generation++; this.retryAfter=0; this.#access='';this.#expires=0;this.#refresh='';clearTimeout(this.expiry);
    void this.save('').catch(()=>{});this.invalidated();
  }
  cancelLogin() { this.controller?.abort(); this.controller=undefined; }
  token() { if(!this.#access||this.now()>=this.#expires) throw new APIError(401);return this.#access; }
  private async post(fields: Record<string,string>, path='/token') {
    return this.request(ISSUER+path,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
  }
  private schedule(delay: number) {
    clearTimeout(this.expiry);
    this.expiry=setTimeout(()=>{void this.renew().catch(()=>{});},delay);
  }
  private async adopt(raw: unknown, generation: number) {
    const value=record(raw);
    if(typeof value.access_token!=='string'||!value.access_token||value.token_type?.toLowerCase()!=='bearer'
      ||!Number.isFinite(value.expires_in)||value.expires_in<=60||value.expires_in>3600
      ||typeof value.refresh_token!=='string'||value.refresh_token.length<16||value.refresh_token.length>8192||value.scope!=='remoteagent:g2')throw Error('INVALID_TOKEN_RESPONSE');
    if(generation!==this.generation)throw Error('LOGIN_CANCELED');
    await this.save(value.refresh_token);
    if(generation!==this.generation)throw Error('LOGIN_CANCELED');
    this.#refresh=value.refresh_token;this.#access=value.access_token;
    this.#expires=this.now()+value.expires_in*1000;
    this.schedule(Math.max(1000,(value.expires_in-300)*1000));this.connected();
  }
  private renew(): Promise<string> {
    if(this.renewal)return this.renewal;
    if(this.now()<this.retryAfter)return Promise.reject(new APIError(429,this.retryAfter));
    const generation=this.generation;
    let retryDelay=30000;
    const work=(async()=>{
      if(!this.#refresh)throw new APIError(401);
      const response=await this.post({grant_type:'refresh_token',refresh_token:this.#refresh,client_id:this.clientId,resource:RESOURCE});
      if(generation!==this.generation)throw Error('LOGIN_CANCELED');
      if(!response.ok){
        if(response.status===429){const h=response.headers.get('Retry-After');const seconds=Number(h);const date=h?Date.parse(h):NaN;retryDelay=Math.max(30000,seconds>0?seconds*1000:Number.isFinite(date)?date-this.now():30000);this.retryAfter=this.now()+retryDelay;}
        if(response.status===400||response.status===401||response.status===403){this.clear();throw new APIError(401);}
        throw new APIError(503);
      }
      try {await this.adopt(await response.json(),generation);}
      catch(e){if(generation===this.generation)this.clear();throw e;}
      return this.token();
    })();
    this.renewal=work;
    void work.catch(()=>{if(generation===this.generation&&this.#refresh)this.schedule(retryDelay);}).finally(()=>{if(this.renewal===work)this.renewal=undefined;});
    return work;
  }
  async getToken() {
    if(this.#access&&this.now()<this.#expires-60000)return this.#access;
    return this.renew();
  }
  async restore() {
    const generation=this.generation;
    const stored=await this.storage.read();
    if(generation!==this.generation)return false;
    if(!stored)return false;
    if(stored.length<16||stored.length>8192){this.clear();return false;}
    this.#refresh=stored;
    try{await this.renew();return true;}catch(error){if(error instanceof APIError&&error.status===401)return false;throw error;}
  }
  async logout() {
    const refresh=this.#refresh;this.cancelLogin();this.clear();await this.writes;
    if(refresh){const r=await this.post({client_id:this.clientId,token:refresh,token_type_hint:'refresh_token'},'/token/revocation');if(!r.ok)throw Error('REVOCATION_FAILED');}
  }
  async login(show: (prompt: DevicePrompt | null) => void) {
    this.cancelLogin(); this.clear();
    const controller = new AbortController(); this.controller = controller;
    const post = (path: string, fields: Record<string,string>) => this.request(ISSUER + path, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
    });
    try {
      const response = await post('/device/auth', { client_id: this.clientId, scope: 'remoteagent:g2', resource: RESOURCE });
      if (!response.ok) throw Error('DEVICE_AUTH_UNAVAILABLE');
      const d = record(await response.json());
      if (typeof d.device_code !== 'string' || d.device_code.length < 20 || d.device_code.length > 2048
        || typeof d.user_code !== 'string' || !/^[A-Z0-9-]{4,20}$/.test(d.user_code)
        || d.verification_uri !== ISSUER + '/device' || !Number.isFinite(d.expires_in) || d.expires_in <= 0 || d.expires_in > 600
        || (d.interval !== undefined && (!Number.isFinite(d.interval) || d.interval < 1 || d.interval > 60))) throw Error('INVALID_DEVICE_RESPONSE');
      controller.signal.throwIfAborted();
      const deadline = this.now() + d.expires_in * 1000;
      let interval = (d.interval ?? 5) * 1000;
      show({ userCode: d.user_code, verificationUri: d.verification_uri, expiresAt: deadline });
      while (this.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(Error('LOGIN_CANCELED')); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, Math.min(interval, deadline - this.now()));
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
        controller.signal.throwIfAborted();
        if (this.now() >= deadline) break;
        let r: Response;
        try { r = await post('/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: this.clientId, resource: RESOURCE }); }
        catch (error) { if (controller.signal.aborted) throw error; interval = Math.min(interval * 2, 60000); continue; }
        controller.signal.throwIfAborted();
        if (r.status === 429) { const seconds = Number(r.headers.get('Retry-After')); interval = Math.max(interval, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000); continue; }
        const token = record(await r.json());
        if (!r.ok) {
          if (token.error === 'authorization_pending') continue;
          if (token.error === 'slow_down') { interval += 5000; continue; }
          throw Error(token.error === 'access_denied' ? 'LOGIN_DENIED' : 'LOGIN_EXPIRED_OR_FAILED');
        }
        controller.signal.throwIfAborted();
        const generation=this.generation;
        await this.adopt(token,generation);
        if(controller.signal.aborted){this.clear();throw Error('LOGIN_CANCELED');}
        return;
      }
      throw Error('LOGIN_EXPIRED');
    } finally { if (this.controller === controller) { this.controller = undefined; show(null); } }
  }
}
