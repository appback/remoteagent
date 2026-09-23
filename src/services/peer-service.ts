import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const PEER_PREFIX = 'RA_PEER_V1:';
type Invite = { id: string; botId: string; username: string; sessionId: string; token: string; expires: number };
type Grant = Omit<Invite, 'token'> & { hash: string; ownerChat: string; sender?: string; nonce?: string; lastAckAt?: number };
type Link = { alias: string; remote: string; username: string; sessionId: string; ownerChat: string; inviteId: string; token?: string; expires: number; nonce?: string; sentAt?: number; verifiedAt?: number };
type State = { grants: Grant[]; links: Link[] };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const id = (s: unknown): s is string => typeof s === 'string' && /^\d{1,16}$/.test(s);
const nonce = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{48}$/.test(s);
export class PeerService {
  private readonly file: string;
  constructor(dataDir: string, readonly botId: string, private readonly now = Date.now) {
    this.file = path.join(dataDir, 'peers', `${botId}.json`);
    if (!id(botId)) throw new Error('Invalid local bot ID');
  }
  private read(): State {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { grants: [], links: [] }; throw e; }
  }
  private save(s: State) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  invite(username: string, sessionId: string, ownerChat: string) {
    const s = this.read();
    s.grants = s.grants.filter(g => g.sender || g.expires > this.now());
    if (s.grants.length >= 50) throw new Error('Peer invite limit reached. Remove unused links first.');
    const v: Invite = { id: randomUUID(), botId: this.botId, username, sessionId, token: randomBytes(24).toString('hex'), expires: this.now() + 30 * 60_000 };
    const { token, ...rest } = v;
    s.grants.push({ ...rest, hash: hash(token), ownerChat }); this.save(s);
    return Buffer.from(JSON.stringify(v)).toString('base64url');
  }
  add(alias: string, encoded: string, ownerChat: string) {
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(alias) || encoded.length > 2048) throw new Error('Usage: /peer add <alias> <invite>');
    let v: Invite;
    try { v = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { throw new Error('Invalid peer invitation'); }
    if (!v || !id(v.botId) || v.botId === this.botId || typeof v.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(v.username) || !nonce(v.token)
      || typeof v.id !== 'string' || v.id.length > 64 || typeof v.sessionId !== 'string' || v.sessionId.length > 128
      || !Number.isFinite(v.expires) || v.expires <= this.now() || v.expires > this.now() + 31 * 60_000) throw new Error('Invalid or expired peer invitation');
    const s = this.read();
    if (s.links.length >= 50 || s.links.some(l => l.alias === alias || l.inviteId === v.id)) throw new Error('Peer alias/invite already registered or limit reached');
    s.links.push({ alias, remote: v.botId, username: v.username, sessionId: v.sessionId, ownerChat, inviteId: v.id, token: v.token, expires: v.expires });
    this.save(s);
  }
  list() {
    const s = this.read();
    return { links: s.links.map(({ token, nonce, ...l }) => l), incoming: s.grants.map(({ hash, nonce, ...g }) => g) };
  }
  remove(selector: string) {
    const s = this.read();
    s.links = s.links.filter(l => l.alias !== selector);
    s.grants = s.grants.filter(g => g.id !== selector);
    this.save(s);
  }
  probe(alias: string) {
    const s = this.read(); const l = s.links.find(l => l.alias === alias);
    if (!l) throw new Error('Unknown peer alias');
    if (l.sentAt && this.now() - l.sentAt < 60_000) throw new Error('Wait 60 seconds before another connection check');
    if (!l.verifiedAt && l.expires <= this.now()) throw new Error('Invitation expired. Issue a new invitation.');
    l.nonce = randomBytes(24).toString('hex'); l.sentAt = this.now();
    this.save(s);
    return { target: `@${l.username}`, text: PEER_PREFIX + JSON.stringify({ type: 'probe', id: l.inviteId, nonce: l.nonce, token: l.token }) };
  }
  async receive(sender: string, text: string, validSession: (sessionId: string, ownerChat: string) => Promise<boolean>) {
    if (!id(sender) || text.length > 2048 || !text.startsWith(PEER_PREFIX)) return;
    let p: { type: string; id: string; nonce: string; token?: string };
    try { p = JSON.parse(text.slice(PEER_PREFIX.length)); } catch { return; }
    if (!p || !nonce(p.nonce) || typeof p.id !== 'string') return;
    const s = this.read();
    if (p.type === 'ack') {
      const l = s.links.find(l => l.remote === sender && l.inviteId === p.id && l.nonce === p.nonce && l.sentAt && this.now() - l.sentAt < 10 * 60_000);
      if (!l) return;
      l.verifiedAt = this.now(); delete l.token; delete l.nonce;
      this.save(s);
      return { ownerChat: l.ownerChat, notice: `Peer ${l.alias}: Telegram 왕복 연결 검증 완료. 작업 전달 기능은 아직 제공하지 않습니다.` };
    }
    if (p.type !== 'probe') return;
    const g = s.grants.find(g => g.id === p.id);
    if (!g || (g.sender ? g.sender !== sender : g.expires <= this.now() || !p.token || hash(p.token) !== g.hash) || g.nonce === p.nonce) return;
    if (!await validSession(g.sessionId, g.ownerChat)) return;
    // Reload after the async session check so a concurrent removal cannot be undone.
    const current = this.read(); const grant = current.grants.find(v => v.id === p.id);
    if (!grant || (grant.sender && grant.sender !== sender) || grant.nonce === p.nonce || (grant.lastAckAt && this.now() - grant.lastAckAt < 60_000)) return;
    const first = !grant.sender;
    grant.sender = sender; grant.nonce = p.nonce; grant.lastAckAt = this.now(); this.save(current);
    return { target: sender, text: PEER_PREFIX + JSON.stringify({ type: 'ack', id: p.id, nonce: p.nonce }),
      ...(first ? { ownerChat: grant.ownerChat, notice: `Peer 봇 ${sender} 등록 요청 확인. 지정 세션 연결 확인에만 사용되며 작업은 실행하지 않습니다.` } : {}) };
  }
}
