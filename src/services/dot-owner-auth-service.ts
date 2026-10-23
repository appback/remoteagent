import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors, type AdapterPayload, type Configuration } from "oidc-provider";
import type { DotPrincipal } from "./dot-mcp-service.js";
import { G2_SCOPE, g2OriginAllowed, type G2Client, type G2Principal } from "./g2-config.js";

const SCOPE = "remoteagent:dot";
const LOGIN_TTL = 300_000;
export type G2PairingControl = {
  preview(code: string): Promise<{ clientId: string; targetLabels: string[] }>;
  decide(code: string, approve: boolean, actor: string): Promise<void>;
};
type Row = { payload: AdapterPayload; expires: number };

// OAuth tokens, grants and signing keys survive restarts independently of LLM sessions.
export class DotAuthStore {
  private readonly file: string;
  private rows: Record<string, Row>;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.file = path.join(dir, "oauth-records.json");
    this.rows = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {};
  }
  adapter(name: string) {
    const key = (id: string) => `${name}:${id}`;
    return {
      upsert: async (id: string, payload: AdapterPayload, expiresIn?: number) => {
        this.prune();
        if (!this.rows[key(id)] && Object.keys(this.rows).length >= 4096) throw Error("DOT_AUTH_CAPACITY");
        this.rows[key(id)] = { payload, expires: expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 31 * 86400000 };
        this.save();
      },
      find: async (id: string) => this.find(key(id)),
      findByUid: async (uid: string) => this.lookup(name, "uid", uid),
      findByUserCode: async (code: string) => this.lookup(name, "userCode", code),
      destroy: async (id: string) => { delete this.rows[key(id)]; this.save(); },
      consume: async (id: string) => { const row = this.rows[key(id)]; if (row) { row.payload.consumed = Math.floor(Date.now() / 1000); this.save(); } },
      revokeByGrantId: async (grantId: string) => {
        for (const [k, row] of Object.entries(this.rows)) if (row.payload.grantId === grantId) delete this.rows[k];
        this.save();
      },
    };
  }
  private find(key: string) {
    const row = this.rows[key];
    return row && row.expires > Date.now() ? structuredClone(row.payload) : undefined;
  }
  private lookup(name: string, field: string, value: string) {
    const match = Object.keys(this.rows).find(k => k.startsWith(`${name}:`) && this.rows[k]!.payload[field] === value);
    return match ? this.find(match) : undefined;
  }
  private prune() { for (const [key, row] of Object.entries(this.rows)) if (row.expires <= Date.now()) delete this.rows[key]; }
  private save() { privateWrite(this.file, JSON.stringify(this.rows)); }
}

function privateWrite(file: string, value: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, value, { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function digest(value: string) { return createHash("sha256").update(value).digest(); }
function equal(a: string, b: string) { return timingSafeEqual(digest(a), digest(b)); }
export function isChatGptClient(id: unknown): boolean {
  return typeof id === "string" && (id === "remoteagent-dot" || /^https:\/\/chatgpt\.com\/oauth\/(?:[a-zA-Z0-9_-]+\/)?client\.json$/.test(id));
}
function validRedirect(uri: string) {
  try {
    const u = new URL(uri);
    return u.origin === "https://chatgpt.com" && !u.search && !u.hash && !u.username && !u.password
      && (u.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(u.pathname));
  } catch { return false; }
}

export class DotOwnerAuthService {
  readonly issuer: string;
  readonly provider: Provider;
  private readonly codes = new Map<string, { expires: number }>();
  private readonly forms = new Map<string, { csrf: string; expires: number; attempts: number }>();
  private readonly origin: string;
  private requestWindow = { start: Date.now(), count: 0 };
  private readonly pairingLocks = new Set<string>();
  constructor(dataDir: string, readonly resource: string, readonly owner: string, private readonly g2Clients: G2Client[] = [], private readonly dotEnabled = true) {
    const url = new URL(resource);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password || !owner) throw Error("DOT_AUTH_INVALID_ORIGIN");
    this.origin = url.origin;
    this.issuer = `${this.origin}/oauth`;
    const dir = path.join(dataDir, "dot", "auth");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "identity.json");
    if (!fs.existsSync(file)) {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      privateWrite(file, JSON.stringify({ issuer: this.issuer, owner, cookies: [randomBytes(48).toString("base64url")],
        jwks: { keys: [{ ...privateKey.export({ format: "jwk" }), kid: randomUUID(), use: "sig", alg: "RS256" }] } }));
    }
    const identity = JSON.parse(fs.readFileSync(file, "utf8"));
    if (identity.issuer !== this.issuer || identity.owner !== owner) throw Error("DOT_AUTH_IDENTITY_CHANGED");
    const store = new DotAuthStore(dir);
    const configuration: Configuration = {
      adapter: name => store.adapter(name),
      jwks: identity.jwks,
      cookies: { keys: identity.cookies, long: { sameSite: "lax" }, short: { sameSite: "lax" } },
      clients: [...(dotEnabled ? [{ client_id: "remoteagent-dot", client_name: "RemoteAgent for ChatGPT", token_endpoint_auth_method: "none" as const,
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], response_types: ["code" as const], grant_types: ["authorization_code", "refresh_token"] }] : []),
        ...g2Clients.map(client => ({ client_id: client.clientId, client_name: "RemoteAgent G2", token_endpoint_auth_method: "none" as const,
          redirect_uris: client.redirectUris, response_types: client.deviceFlow ? [] : ["code"] as const,
          grant_types: client.deviceFlow ? ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"] as const : ["authorization_code"] as const, scope: G2_SCOPE }))],
      scopes: ["openid", ...(dotEnabled ? ["offline_access", SCOPE] : []), ...(g2Clients.length ? [G2_SCOPE] : [])],
      clientBasedCORS: (_ctx, origin, client) => g2Clients.some(c => c.clientId === client.clientId && g2OriginAllowed(c, origin)),
      claims: { openid: ["sub"] },
      responseTypes: ["code"],
      pkce: { required: () => true },
      features: {
        devInteractions: { enabled: false },
        deviceFlow: { enabled: g2Clients.some(client => client.deviceFlow),
          userCodeInputSource: async (ctx, form) => {
            ctx.body = `<!doctype html><html lang="ko"><meta charset="utf-8"><h1>G2 연결 코드</h1><p>본인의 G2 앱에 표시된 코드를 입력하세요.</p>${form}<button type="submit" form="op.deviceInputForm">코드 확인</button></html>`;
          },
          userCodeConfirmSource: async (ctx, form, _client, _info, userCode) => {
            const code = String(userCode).replace(/[^A-Z0-9-]/g, "");
            ctx.body = `<!doctype html><html lang="ko"><meta charset="utf-8"><h1>G2 연결 확인</h1><p>G2 앱의 코드와 일치하는지 확인하세요.</p><strong>${code}</strong>${form}<button type="submit" form="op.deviceConfirmForm">일치합니다</button><button type="submit" form="op.deviceConfirmForm" name="abort" value="yes">취소</button></html>`;
          },
          successSource: async ctx => { ctx.body = '<!doctype html><html lang="ko"><meta charset="utf-8"><h1>연결 승인 완료</h1><p>G2 앱으로 돌아가세요.</p></html>'; },
        },
        clientIdMetadataDocument: { enabled: dotEnabled, ack: "draft-02",
          allowFetch: (_ctx, id) => isChatGptClient(id),
          allowClient: (_ctx, client) => isChatGptClient(client.clientId) && Boolean(client.redirectUris?.length) && client.redirectUris!.every(validRedirect) },
        resourceIndicators: { enabled: true, defaultResource: () => resource, useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, indicator) => {
            if (indicator === `${resource}/api/v1` && g2Clients.length)
              return { scope: G2_SCOPE, audience: indicator, accessTokenFormat: "opaque", accessTokenTTL: 3600 };
            if (!dotEnabled || indicator !== resource) throw new errors.InvalidTarget();
            return { scope: SCOPE, audience: resource, accessTokenFormat: "opaque", accessTokenTTL: 3600 };
          } },
        revocation: { enabled: true },
      },
      ttl: { DeviceCode: 300, AccessToken: 3600, IdToken: 3600, AuthorizationCode: 60, Interaction: 300, Session: 86400, Grant: 30 * 86400, RefreshToken: 30 * 86400 },
      expiresWithSession: () => false,
      issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
      findAccount: async (_ctx, sub) => sub === owner ? { accountId: owner, claims: async () => ({ sub: owner }) } : undefined,
      interactions: { url: (_ctx, interaction) => `${this.issuer}/interaction/${interaction.uid}` },
    };
    this.provider = new Provider(this.issuer, configuration);
    this.provider.proxy = true;
    // Never log protocol error objects: they can contain codes or tokens.
    this.provider.on("server_error", () => console.error("Dot OAuth server error; credentials omitted."));
  }

  issueLoginCode(): { code: string; expiresAt: string } {
    this.prune();
    if (this.codes.size >= 16) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(16).toString("base64url");
    const expires = Date.now() + LOGIN_TTL;
    this.codes.set(digest(code).toString("hex"), { expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  private async g2Device(code: string) {
    if (!/^[A-Z0-9-]{6,24}$/.test(code)) throw Error("INVALID_DEVICE_CODE");
    const device = await this.provider.DeviceCode.findByUserCode(code.replace(/-/g, ""));
    const client = this.g2Clients.find(c => c.deviceFlow && c.clientId === device?.clientId);
    const resources = device?.params?.resource;
    const resource = Array.isArray(resources) && resources.length === 1 ? resources[0] : resources;
    if (!device || !client || device.isExpired || device.consumed || device.accountId || device.error || device.inFlight
      || device.params?.scope !== G2_SCOPE || resource !== this.resource + "/api/v1") throw Error("INVALID_DEVICE_CODE");
    return { device, client };
  }
  async previewG2Device(code: string) {
    const { client } = await this.g2Device(code);
    return { clientId: client.clientId, targetIds: [...client.targetIds] };
  }
  async decideG2Device(code: string, approve: boolean, actor: string) {
    if (actor !== this.owner) throw Error("UNAUTHORIZED");
    const key = code.replace(/-/g, "");
    if (this.pairingLocks.has(key)) throw Error("PAIRING_BUSY");
    this.pairingLocks.add(key);
    try {
      const { device, client } = await this.g2Device(code);
      if (!approve) { Object.assign(device, { error: "access_denied", errorDescription: "Owner declined device pairing" }); await device.save(); return; }
      const grant = new this.provider.Grant({ accountId: this.owner, clientId: client.clientId });
      grant.addOIDCScope(G2_SCOPE); grant.addResourceScope(this.resource + "/api/v1", G2_SCOPE);
      const grantId = await grant.save();
      try {
        Object.assign(device, { accountId: this.owner, authTime: Math.floor(Date.now() / 1000),
          grantId, scope: G2_SCOPE, resource: this.resource + "/api/v1" });
        await device.save();
      } catch (error) { await grant.destroy(); throw error; }
    } finally { this.pairingLocks.delete(key); }
  }
  async authenticate(authorization: string | undefined): Promise<DotPrincipal | undefined> {
    if (!this.dotEnabled) return;
    const value = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")?.[1];
    if (!value || value.length > 8192) return;
    try {
      const token = await this.provider.AccessToken.find(value);
      if (!token || token.accountId !== this.owner || token.isExpired || typeof token.exp !== "number" || token.exp * 1000 <= Date.now() + 60_000
        || token.aud !== this.resource || !token.scope?.split(" ").includes(SCOPE) || !isChatGptClient(token.clientId)
        || !await this.provider.Grant.find(token.grantId)) return;
      return { subject: this.owner, expiresAt: token.exp * 1000 };
    } catch { return; }
  }
  async authenticateG2(authorization: string | undefined): Promise<G2Principal | undefined> {
    const value = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")?.[1];
    if (!value || value.length > 8192) return;
    try {
      const token = await this.provider.AccessToken.find(value);
      const client = this.g2Clients.find(c => c.clientId === token?.clientId);
      if (!token || !client || token.accountId !== this.owner || token.isExpired
        || typeof token.exp !== "number" || token.exp * 1000 <= Date.now() + 60000
        || token.aud !== `${this.resource}/api/v1` || !token.scope?.split(" ").includes(G2_SCOPE)
        || !await this.provider.Grant.find(token.grantId)) return;
      return { subject: this.owner, clientId: client.clientId, expiresAt: token.exp * 1000, targetIds: [...client.targetIds] };
    } catch { return; }
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", this.origin);
    if (!url.pathname.startsWith("/oauth/")) return false;
    this.prune();
    if (Date.now() - this.requestWindow.start > 60_000) this.requestWindow = { start: Date.now(), count: 0 };
    if (++this.requestWindow.count > 120) { res.writeHead(429, { "Retry-After": "60" }).end(); return true; }
    res.setHeader("Cache-Control", "no-store");
    // no-referrer makes browsers serialize a form POST's Origin as "null".
    // same-origin preserves CSRF origin checks without leaking OAuth URLs cross-site.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self' https://chatgpt.com/connector_platform_oauth_redirect https://chatgpt.com/connector/oauth/"
      // oidc-provider appends the exact SHA-256 for its own form-post script to
      // this empty directive; arbitrary inline scripts remain disallowed.
      + this.g2Clients.flatMap(c => c.redirectUris).map(uri => ` ${uri}`).join("") + "; script-src; frame-ancestors 'none'; base-uri 'none'");
    // Only the loopback listener sits behind the configured HTTPS proxy.
    if (req.headers["x-forwarded-proto"] !== "https") { res.writeHead(400).end("HTTPS proxy required"); return true; }
    if ((req.headers["x-forwarded-host"] ?? req.headers.host) !== new URL(this.origin).host) { res.writeHead(400).end("Invalid host"); return true; }
    const interaction = /^\/oauth\/interaction\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (interaction) { await this.interact(req, res, interaction[1]!); return true; }
    (req as IncomingMessage & { originalUrl: string }).originalUrl = req.url ?? "/";
    req.url = (req.url ?? "/").slice("/oauth".length);
    await this.provider.callback()(req, res);
    return true;
  }
  private async interact(req: IncomingMessage, res: ServerResponse, uid: string) {
    const details = await this.provider.interactionDetails(req, res).catch(() => undefined);
    const g2Client = this.g2Clients.find(client => client.clientId === details?.params.client_id);
    if (!details || details.uid !== uid || (!(this.dotEnabled && isChatGptClient(details.params.client_id)) && !g2Client)) { res.writeHead(400).end("Invalid or expired login"); return; }
    const requestedScopes = String(details.params.scope ?? "").split(" ");
    const expectedResource = g2Client ? `${this.resource}/api/v1` : this.resource;
    if ((g2Client && details.params.resource !== expectedResource) || (details.params.resource && details.params.resource !== expectedResource)
      || (g2Client ? requestedScopes.some(scope => scope !== G2_SCOPE) : requestedScopes.includes(G2_SCOPE))) {
      res.writeHead(400).end("Invalid resource or scope"); return;
    }
    if (req.method === "GET") {
      if (this.forms.size >= 32 && !this.forms.has(uid)) { res.writeHead(429).end("Try again later"); return; }
      const csrf = randomBytes(24).toString("base64url");
      this.forms.set(uid, { csrf, expires: Date.now() + LOGIN_TTL, attempts: 0 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RemoteAgent 연결 승인</title><h1>RemoteAgent 연결 승인</h1><p>${g2Client ? "G2 앱에 관리자가 허용한 세션의 작업 요청과 결과 조회를 허용합니다." : "ChatGPT에 이 서버의 Telegram 지시 읽기와 응답 전송을 허용합니다."}</p><p>본인이 연결을 시작한 경우에만 Telegram의 /login ${g2Client ? "g2" : "dot"}에서 받은 5분 유효 코드를 입력하세요. 다른 사람이 요청한 코드를 전달하지 마세요.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>승인 코드 <input name="code" autocomplete="off" required maxlength="80"></label><button type="submit">연결 허용</button></form></html>`);
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const form = this.forms.get(uid);
    if (!form || form.expires <= Date.now() || form.attempts++ >= 5 || req.headers.origin !== this.origin
      || !(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) { res.writeHead(403).end("Login rejected"); return; }
    let body = "";
    for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 1024) { res.writeHead(413).end(); return; } }
    const input = new URLSearchParams(body);
    const key = digest(input.get("code") ?? "").toString("hex");
    const credential = this.codes.get(key);
    if (!equal(input.get("csrf") ?? "", form.csrf) || !credential || credential.expires <= Date.now()) { res.writeHead(403).end(g2Client ? "Invalid or expired approval code. Run /login g2 again." : "Invalid or expired approval code. Run /login dot again."); return; }
    this.codes.delete(key);
    this.forms.delete(uid);
    const clientId = String(details.params.client_id);
    const grant = details.grantId ? await this.provider.Grant.find(details.grantId) : new this.provider.Grant({ accountId: this.owner, clientId });
    if (!grant || (grant.accountId && grant.accountId !== this.owner)) { res.writeHead(403).end(); return; }
    grant.addOIDCScope(g2Client ? G2_SCOPE : `openid offline_access ${SCOPE}`);
    grant.addResourceScope(expectedResource, g2Client ? G2_SCOPE : SCOPE);
    const grantId = await grant.save();
    await this.provider.interactionFinished(req, res, { login: { accountId: this.owner }, consent: { grantId } }, { mergeWithLastSubmission: false });
  }
  private prune() {
    for (const [key, value] of this.codes) if (value.expires <= Date.now()) this.codes.delete(key);
    for (const [key, value] of this.forms) if (value.expires <= Date.now()) this.forms.delete(key);
  }
}
