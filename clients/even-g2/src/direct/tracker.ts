import { APIError, terminal, type Target, type Submission, type Snapshot, type RequestAPI, type Status, type Cancellation, type Result } from './types';
import { validateSubmission } from './api';
export const CHECKPOINT_KEY = 'g2.request-checkpoints.v1';
type Work = { targetId: string; clientRequestId: string; hash: string; requestId?: string; seq: number;
  status?: Status; result?: Result; cancel?: Cancellation; progress: string[]; notice: string; input?: Submission };
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2,'0')).join('');
export class Tracker {
  private works = new Map<string, Work>(); private posting = new Set<string>(); private selecting = 0;
  private timer?: ReturnType<typeof setTimeout>; private polling = false; private paused = false;
  selected?: Target;
  constructor(private api: RequestAPI, private storage: Storage, private changed = () => {}, private now = Date.now) {
    try {
      const data = JSON.parse(storage.getItem(CHECKPOINT_KEY) ?? '[]');
      if (Array.isArray(data) && data.length <= 128) for (const v of data) if (v && /^tgt_[a-zA-Z0-9_-]+$/.test(v.targetId) && /^[a-zA-Z0-9_-]{1,80}$/.test(v.clientRequestId) && /^[a-f0-9]{64}$/.test(v.hash) && Number.isSafeInteger(v.seq) && v.seq >= 0 && (v.requestId === undefined || /^req_[a-zA-Z0-9_-]+$/.test(v.requestId))) this.works.set(v.targetId, { targetId: v.targetId, clientRequestId: v.clientRequestId, hash: v.hash, requestId: v.requestId, seq: v.seq, progress: [], notice: v.requestId ? '재로그인 후 이어서 조회하세요.' : '접수 여부 불명 · 원문을 똑같이 입력해 같은 ID로 재시도하세요.' });
    } catch { /* invalid checkpoint is not executed */ }
  }
  get work() { return this.selected ? this.works.get(this.selected.targetId) : undefined; }
  get busy() { return !!this.selected && this.posting.has(this.selected.targetId); }
  private persist() {
    const values = [...this.works.values()].map(({ targetId, clientRequestId, hash, requestId, seq }) => ({ targetId, clientRequestId, hash, requestId, seq }));
    // No token, transcript, result or OAuth data. Failure blocks submission before side effects.
    this.storage.setItem(CHECKPOINT_KEY, JSON.stringify(values));
  }
  deselect() { clearTimeout(this.timer); this.selected = undefined; this.selecting++; this.changed(); }
  select(target: Target) { clearTimeout(this.timer); this.selected = { ...target }; this.selecting++; this.changed(); if (!this.paused && this.work?.requestId) this.schedule(0); }
  pause() { this.paused = true; clearTimeout(this.timer); this.selecting++; }
  resume() { this.paused = false; if (this.work?.requestId) this.schedule(0); }
  private schedule(ms: number) { clearTimeout(this.timer); if (!this.paused) this.timer = setTimeout(() => void this.poll(), ms); }
  private apply(w: Work, s: Snapshot, resetCursor = false) {
    if (s.targetId !== w.targetId || s.clientRequestId !== w.clientRequestId || (w.requestId && s.requestId !== w.requestId)) throw Error('CORRELATION_MISMATCH');
    w.requestId = s.requestId; w.status = s.status; w.result = s.result; w.cancel = s.cancel;
    if (resetCursor) w.seq = s.lastSeq;
    w.notice = s.status === 'accepted' ? '접수됨 · 실행 시작은 아직 확인되지 않음' : '';
    this.persist(); this.changed();
  }
  async send(text: string) {
    const target = this.selected; if (!target || this.posting.has(target.targetId)) return;
    this.posting.add(target.targetId); this.changed();
    let w = this.works.get(target.targetId);
    try {
      const digest = await hash(JSON.stringify([target.targetId, text]));
      if (w && !terminal(w.status!)) {
        if (w.requestId) throw Error('EXISTING_REQUEST_USE_RECONNECT');
        if (w.hash !== digest) throw Error('RETRY_REQUIRES_IDENTICAL_TEXT');
      } else {
        if (!target.available) throw Error('TARGET_UNAVAILABLE');
        if (!w && this.works.size >= 128) throw Error('LOCAL_CAPACITY');
        w = { targetId: target.targetId, clientRequestId: crypto.randomUUID(), hash: digest, seq: 0, progress: [], notice: '' };
      }
      const input = { targetId: target.targetId, clientRequestId: w.clientRequestId, text };
      validateSubmission(input); w.input = input; this.works.set(target.targetId, w); this.persist();
      w.notice = '접수 확인 중'; this.changed();
      try { this.apply(w, await this.api.submit(input)); }
      catch (e) { w.notice = e instanceof APIError && e.status === 429 ? '요청 제한 · 안내된 시간 이후 같은 ID로 재시도' : e instanceof APIError && e.status === 401 ? '재로그인 필요 · 같은 요청 ID 유지' : '접수 여부 불명 · 같은 내용과 ID로만 재시도'; throw e; }
      if (this.selected?.targetId === target.targetId && !terminal(w.status!)) this.schedule(3000);
    } finally { this.posting.delete(target.targetId); this.changed(); }
  }
  async poll() {
    if (this.paused || this.polling) return;
    clearTimeout(this.timer);
    const w = this.work, generation = this.selecting; if (!w?.requestId) return;
    this.polling = true; let delay: number | undefined;
    try {
      const page = await this.api.events(w.requestId, w.seq);
      if (generation !== this.selecting) return;
      const before = w.seq; let previous = 0;
      for (const e of page.events) {
        if (e.seq < previous) throw Error('OUT_OF_ORDER_EVENTS'); previous = e.seq;
        if (e.seq <= w.seq) continue;
        if (w.seq !== 0 && e.seq !== w.seq + 1) throw Error('EVENT_GAP');
        if (e.type === 'progress') { if (typeof e.text === 'string') w.progress = [...w.progress, e.text + (e.truncated ? ' [잘림]' : '')].slice(-100); w.status = 'running'; }
        else if (e.type === 'result') { w.status = 'completed'; w.result = { text: typeof e.text === 'string' ? e.text : '', outcome: ['succeeded','failed','unknown'].includes(String(e.outcome)) ? e.outcome! : 'unknown', truncated: e.truncated === true }; }
        else w.status = e.type === 'error' ? 'failed' : e.type;
        // Mark only after this event has been applied; never trust nextCursor as processed.
        w.seq = e.seq; this.persist(); this.changed();
      }
      if (page.hasMore) { if (w.seq === before) throw Error('EMPTY_MORE_PAGE'); delay = 0; }
      else if (terminal(page.status) || terminal(w.status!)) { const s = await this.api.snapshot(w.requestId); if (generation === this.selecting) this.apply(w, s); }
      else delay = 3000;
    } catch (e) {
      if (generation !== this.selecting) return;
      if (e instanceof APIError && e.status === 410) {
        try { const s = await this.api.snapshot(w.requestId); if (generation === this.selecting) { this.apply(w, s, true); if (!terminal(s.status)) delay = 3000; } }
        catch (error) { w.notice = '복구 조회 실패 · 재접수하지 마세요'; if (error instanceof APIError && error.status === 429) delay = Math.max(0, error.retryAt - this.now()); else if (!(error instanceof APIError && error.status === 401)) delay = 3000; }
      } else if (e instanceof APIError && e.status === 401) { w.notice = '재로그인 필요 · 요청은 재접수하지 않습니다'; this.pause(); }
      else if (e instanceof APIError && [403,404,409].includes(e.status)) { w.notice = '대상/요청 접근 불가 · 자동 재접수나 대상 변경 안 함'; }
      else { w.notice = '조회 실패 · 처리한 커서부터 다시 연결'; delay = e instanceof APIError && e.status === 429 ? Math.max(0, e.retryAt - this.now()) : 3000; }
      this.changed();
    } finally {
      this.polling = false;
      if (generation === this.selecting && delay !== undefined) this.schedule(delay);
      else if (generation !== this.selecting && !this.paused && this.work?.requestId) this.schedule(3000);
    }
  }
  async cancel() {
    const w = this.work, generation = this.selecting; if (!w?.requestId || terminal(w.status!)) return;
    try { const s = await this.api.cancel(w.requestId); if (generation !== this.selecting) return; this.apply(w, s); if (!terminal(s.status)) this.schedule(3000); else clearTimeout(this.timer); }
    catch (e) { w.notice = e instanceof APIError && e.status === 429 ? '취소 요청 제한 · 잠시 후 다시 확인' : '취소 여부 불명 · 같은 요청 상태를 조회하세요'; this.changed(); throw e; }
  }
}
