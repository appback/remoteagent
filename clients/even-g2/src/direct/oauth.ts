import { APIError, record } from './types';
export const ORIGIN = 'https://remoteagent-dot60.appback.app';
export const RESOURCE = ORIGIN + '/api/v1';
export const ISSUER = ORIGIN + '/oauth';
export const FLOW_KEY = 'g2.oauth.attempt';
export type LiveConfig = { mode: 'live'; appOrigin: string; callbackUrl: string; clientId: string };
export function liveConfig(v: unknown): LiveConfig {
  const c = record(v), origin = new URL(c.appOrigin), callback = new URL(c.callbackUrl);
  if (c.mode !== 'live' || origin.protocol !== 'https:' || origin.origin !== c.appOrigin || origin.username || origin.password || callback.origin !== origin.origin || callback.username || callback.password || callback.search || callback.hash || !/^remoteagent-g2-[a-zA-Z0-9_-]+$/.test(c.clientId)) throw Error('LIVE_CONFIG_REQUIRED');
  return c as LiveConfig;
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export class OAuth {
  private epoch = 0;
  #token = ''; #expires = 0; private expiry?: ReturnType<typeof setTimeout>;
  private flowExpiry?: ReturnType<typeof setTimeout>;
  constructor(readonly config: LiveConfig, private storage: Storage, private request: typeof fetch = fetch, private now = Date.now, private invalidated = () => {}) { const transport = request; this.request = (...args) => transport(...args); this.prune(); }
  private prune() {
    try { const f = JSON.parse(this.storage.getItem(FLOW_KEY) ?? 'null'); if (!f || !Number.isFinite(f.createdAt) || this.now() - f.createdAt >= 300000 || f.createdAt > this.now()) this.storage.removeItem(FLOW_KEY); else this.flowExpiry = setTimeout(() => this.cancelLogin(), 300000 - (this.now() - f.createdAt)); }
    catch { this.storage.removeItem(FLOW_KEY); }
  }
  clear() { this.epoch++; this.#token = ''; this.#expires = 0; clearTimeout(this.expiry); this.invalidated(); }
  token() { if (!this.#token || this.now() >= this.#expires) { this.clear(); throw new APIError(401); } return this.#token; }
  cancelLogin() { this.epoch++; clearTimeout(this.flowExpiry); this.storage.removeItem(FLOW_KEY); }
  async authorize(): Promise<string> {
    this.clear(); this.cancelLogin(); const generation = this.epoch;
    const metadata = await this.request(ISSUER + '/.well-known/openid-configuration', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (!metadata.ok) throw Error('OAUTH_UNAVAILABLE');
    const m = record(await metadata.json());
    if (m.issuer !== ISSUER || m.authorization_endpoint !== ISSUER + '/auth' || m.token_endpoint !== ISSUER + '/token' || !Array.isArray(m.code_challenge_methods_supported) || !m.code_challenge_methods_supported.includes('S256')) throw Error('OAUTH_METADATA_INVALID');
    const state = b64(crypto.getRandomValues(new Uint8Array(32))), verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    if (generation !== this.epoch) throw Error('LOGIN_CANCELED');
    this.storage.setItem(FLOW_KEY, JSON.stringify({ state, verifier, createdAt: this.now() }));
    this.flowExpiry = setTimeout(() => this.cancelLogin(), 300000);
    const url = new URL(ISSUER + '/auth');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.callbackUrl, response_type: 'code', scope: 'remoteagent:g2', resource: RESOURCE, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return url.href;
  }
  async callback(href: string, replace: (clean: string) => void): Promise<boolean> {
    const url = new URL(href), p = new URLSearchParams(url.search);
    if (!['code','state','error','iss'].some(k => p.has(k))) return false;
    const raw = this.storage.getItem(FLOW_KEY); this.cancelLogin();
    const original = new URL(url);
    for (const key of ['code','state','iss','error','error_description','error_uri','session_state']) url.searchParams.delete(key);
    replace(url.pathname + url.search + url.hash); // Clean before validation or any network request.
    this.clear(); const generation = this.epoch;
    try {
      const f = JSON.parse(raw ?? 'null');
      if (original.origin + original.pathname !== this.config.callbackUrl || !f || typeof f.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(f.verifier) || !Number.isFinite(f.createdAt) || this.now() - f.createdAt >= 300000 || f.createdAt > this.now() || p.getAll('state').length !== 1 || p.get('state') !== f.state || p.getAll('iss').length !== 1 || p.get('iss') !== ISSUER || p.has('error') || p.getAll('code').length !== 1 || !p.get('code')) throw Error('INVALID_CALLBACK');
      const response = await this.request(ISSUER + '/token', { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.clientId, redirect_uri: this.config.callbackUrl, code: p.get('code')!, code_verifier: f.verifier, resource: RESOURCE }) });
      if (!response.ok) throw Error('TOKEN_EXCHANGE_FAILED');
      const token = record(await response.json());
      if (typeof token.access_token !== 'string' || !token.access_token || token.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in) || token.expires_in <= 60 || token.expires_in > 3600 || token.refresh_token !== undefined || (token.scope && token.scope !== 'remoteagent:g2')) throw Error('TOKEN_RESPONSE_INVALID');
      if (generation !== this.epoch) throw Error('LOGIN_CANCELED');
      this.#token = token.access_token; this.#expires = this.now() + (token.expires_in - 60) * 1000;
      this.expiry = setTimeout(() => this.clear(), (token.expires_in - 60) * 1000);
      return true;
    } catch { this.clear(); throw Error('LOGIN_FAILED'); }
    finally { this.cancelLogin(); }
  }
}
