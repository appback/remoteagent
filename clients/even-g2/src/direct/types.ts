export type Target = { targetId: string; type: 'session' | 'dot_channel'; provider: 'codex' | 'claude' | 'dot'; label: string; available: boolean; cancelMode: 'execution' | 'delivery_only' };
export type Status = 'accepted' | 'running' | 'completed' | 'failed' | 'cancel_requested' | 'canceled' | 'interrupted';
export type Result = { text: string; outcome: 'succeeded' | 'failed' | 'unknown'; truncated: boolean };
export type Cancellation = { scope: 'execution' | 'delivery_only'; confirmed: boolean; executionStopped: boolean };
export type Snapshot = { requestId: string; clientRequestId: string; targetId: string; status: Status; lastSeq: number; result?: Result; error?: unknown; cancel?: Cancellation };
export type Event = { seq: number; type: 'accepted' | 'running' | 'progress' | 'result' | 'error' | 'cancel_requested' | 'canceled' | 'interrupted'; text?: string; outcome?: Result['outcome']; truncated?: boolean; [key: string]: unknown };
export type Page = { requestId: string; events: Event[]; nextCursor: number; hasMore: boolean; status: Status };
export type Submission = { targetId: string; clientRequestId: string; text: string };
export interface RequestAPI {
  targets(signal?: AbortSignal): Promise<Target[]>;
  submit(input: Submission, signal?: AbortSignal): Promise<Snapshot>;
  snapshot(id: string, signal?: AbortSignal): Promise<Snapshot>;
  events(id: string, after: number, signal?: AbortSignal): Promise<Page>;
  cancel(id: string, signal?: AbortSignal): Promise<Snapshot>;
}
export const terminal = (status: Status) => ['completed', 'failed', 'canceled', 'interrupted'].includes(status);
export class APIError extends Error {
  constructor(readonly status: number, readonly retryAt = 0) { super(status === 401 ? 'LOGIN_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED'); }
}
export const record = (v: unknown): Record<string, any> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('INVALID_RESPONSE'); return v as Record<string, any>; };
export const statuses: Status[] = ['accepted', 'running', 'completed', 'failed', 'cancel_requested', 'canceled', 'interrupted'];
export function snapshot(value: unknown): Snapshot {
  const v = record(value);
  if (typeof v.requestId !== 'string' || !/^req_[a-zA-Z0-9_-]+$/.test(v.requestId) || typeof v.clientRequestId !== 'string' || typeof v.targetId !== 'string' || !statuses.includes(v.status) || !Number.isSafeInteger(v.lastSeq) || v.lastSeq < 0) throw Error('INVALID_SNAPSHOT');
  if (v.result && (typeof v.result.text !== 'string' || v.result.text.length > 16384 || !['succeeded','failed','unknown'].includes(v.result.outcome) || typeof v.result.truncated !== 'boolean')) throw Error('INVALID_RESULT');
  if (v.cancel && (!['execution','delivery_only'].includes(v.cancel.scope) || typeof v.cancel.confirmed !== 'boolean' || typeof v.cancel.executionStopped !== 'boolean')) throw Error('INVALID_CANCEL');
  return v as Snapshot;
}
