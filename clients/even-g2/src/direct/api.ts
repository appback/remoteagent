import { APIError, record, snapshot, statuses, type RequestAPI, type Target, type Submission, type Page } from './types';
import { RESOURCE, type OAuth } from './oauth';
export function retryAt(header: string | null, now: number): number {
  if (header && /^\d+(\.\d+)?$/.test(header)) return now + Math.ceil(Number(header) * 1000);
  const date = header ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(now, date) : now + 3000;
}
export function validateSubmission(v: Submission) {
  if (!/^tgt_[a-zA-Z0-9_-]+$/.test(v.targetId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(v.clientRequestId) || !v.text.trim() || new TextEncoder().encode(v.text).length > 32768 || new TextEncoder().encode(JSON.stringify(v)).length > 65536) throw Error('REQUEST_TOO_LARGE_OR_INVALID');
}
export class RemoteAPI implements RequestAPI {
  private blockedUntil = 0;
  constructor(private auth: Pick<OAuth, 'token' | 'clear'> & { getToken?: () => Promise<string> }, private request: typeof fetch = fetch, private now = Date.now) { const transport = request; this.request = (...args) => transport(...args); }
  private async call(path: string, body?: unknown, signal?: AbortSignal) {
    if (this.now() < this.blockedUntil) throw new APIError(429, this.blockedUntil);
    const token = this.auth.getToken ? await this.auth.getToken() : this.auth.token();
    const res = await this.request(RESOURCE + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.status === 401) this.auth.clear();
    if (res.status === 429) this.blockedUntil = retryAt(res.headers.get('Retry-After'), this.now());
    if (!res.ok) throw new APIError(res.status, this.blockedUntil);
    const raw = await res.text(); if (raw.length > 1_000_000) throw Error('RESPONSE_TOO_LARGE');
    return JSON.parse(raw);
  }
  async targets(signal?: AbortSignal): Promise<Target[]> {
    const v = record(await this.call('/targets', undefined, signal));
    if (!Array.isArray(v.targets)) throw Error('INVALID_TARGETS');
    return v.targets.map((raw: unknown) => { const t = record(raw);
      if (!/^tgt_[a-zA-Z0-9_-]+$/.test(t.targetId) || !['codex','claude','dot'].includes(t.provider) || !['session','dot_channel'].includes(t.type) || (t.provider === 'dot') !== (t.type === 'dot_channel') || typeof t.label !== 'string' || typeof t.available !== 'boolean' || !['execution','delivery_only'].includes(t.cancelMode)) throw Error('INVALID_TARGET');
      return t as Target;
    });
  }
  async capabilities() {
    const result = record(await this.call('/capabilities'));
    return result.audio?.available === true && result.audio?.sampleRate === 16000 && result.audio?.format === 's16le';
  }
  async transcribe(targetId: string, pcm: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<string> {
    if (this.now() < this.blockedUntil) throw new APIError(429, this.blockedUntil);
    const token = this.auth.getToken ? await this.auth.getToken() : this.auth.token();
    const response = await this.request(RESOURCE + '/audio/transcriptions?targetId=' + encodeURIComponent(targetId), {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'audio/pcm' }, body: pcm,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(125000)]) : AbortSignal.timeout(125000),
    });
    if (response.status === 401) this.auth.clear();
    if (response.status === 429) this.blockedUntil = retryAt(response.headers.get('Retry-After'), this.now());
    const raw = await response.text();
    if (raw.length > 65536) throw Error('RESPONSE_TOO_LARGE');
    const value = record(JSON.parse(raw));
    if (!response.ok) {
      if (value.error === 'NO_SPEECH') throw Error('NO_SPEECH');
      throw new APIError(response.status, this.blockedUntil);
    }
    if (typeof value.text !== 'string' || !value.text.trim() || new TextEncoder().encode(value.text).length > 32768) throw Error('INVALID_TRANSCRIPT');
    return value.text;
  }
  async submit(input: Submission, signal?: AbortSignal) { validateSubmission(input); const s = snapshot(await this.call('/requests', input, signal)); if (s.clientRequestId !== input.clientRequestId || s.targetId !== input.targetId) throw Error('CORRELATION_MISMATCH'); return s; }
  private path(id: string) { if (!/^req_[a-zA-Z0-9_-]+$/.test(id)) throw Error('INVALID_REQUEST_ID'); return '/requests/' + encodeURIComponent(id); }
  async snapshot(id: string, signal?: AbortSignal) { const s = snapshot(await this.call(this.path(id), undefined, signal)); if (s.requestId !== id) throw Error('CORRELATION_MISMATCH'); return s; }
  async cancel(id: string, signal?: AbortSignal) { const s = snapshot(await this.call(this.path(id) + '/cancel', {}, signal)); if (s.requestId !== id) throw Error('CORRELATION_MISMATCH'); return s; }
  async events(id: string, after: number, signal?: AbortSignal): Promise<Page> {
    const v = record(await this.call(this.path(id) + '/events?after=' + after + '&limit=100', undefined, signal));
    if (v.requestId !== id || !Array.isArray(v.events) || v.events.length > 100 || typeof v.hasMore !== 'boolean' || !Number.isSafeInteger(v.nextCursor) || !statuses.includes(v.status)) throw Error('INVALID_EVENTS');
    for (const e of v.events) if (!e || !Number.isSafeInteger(e.seq) || e.seq <= 0 || !['accepted','running','progress','result','error','cancel_requested','canceled','interrupted'].includes(e.type) || (e.text !== undefined && (typeof e.text !== 'string' || e.text.length > 16384))) throw Error('INVALID_EVENT');
    return v as Page;
  }
}
