import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors, type AdapterPayload, type Configuration } from "oidc-provider";
import type { DotPrincipal } from "./dot-mcp-service.js";

const SCOPE = "remoteagent:dot";
const LOGIN_TTL = 300_000;
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
  constructor(dataDir: string, readonly resource: string, readonly owner: string) {
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
      clients: [{ client_id: "remoteagent-dot", client_name: "RemoteAgent for ChatGPT", token_endpoint_auth_method: "none",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], response_types: ["code"], grant_types: ["authorization_code", "refresh_token"] }],
      scopes: ["openid", "offline_access", SCOPE],
      claims: { openid: ["sub"] },
      responseTypes: ["code"],
      pkce: { required: () => true },
      features: {
        devInteractions: { enabled: false },
        clientIdMetadataDocument: { enabled: true, ack: "draft-02",
          allowFetch: (_ctx, id) => isChatGptClient(id),
          allowClient: (_ctx, client) => isChatGptClient(client.clientId) && Boolean(client.redirectUris?.length) && client.redirectUris!.every(validRedirect) },
        resourceIndicators: { enabled: true, defaultResource: () => resource, useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, indicator) => {
            if (indicator !== resource) throw new errors.InvalidTarget();
            return { scope: SCOPE, audience: resource, accessTokenFormat: "opaque", accessTokenTTL: 3600 };
          } },
        revocation: { enabled: true },
      },
      ttl: { AccessToken: 3600, IdToken: 3600, AuthorizationCode: 60, Interaction: 300, Session: 86400, Grant: 30 * 86400, RefreshToken: 30 * 86400 },
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
  async authenticate(authorization: string | undefined): Promise<DotPrincipal | undefined> {
    const value = /^Bearer ([^\s]+)$/i.exec(authorization ?? "")?.[1];
    if (!value || value.length > 8192) return;
    try {
      const token = await this.provider.AccessToken.find(value);
      if (!token || token.accountId !== this.owner || token.isExpired || typeof token.exp !== "number" || token.exp * 1000 <= Date.now() + 60_000
        || token.aud !== this.resource || !token.scope?.split(" ").includes(SCOPE)
        || !await this.provider.Grant.find(token.grantId)) return;
      return { subject: this.owner, expiresAt: token.exp * 1000 };
    } catch { return; }
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", this.origin);
    if (!url.pathname.startsWith("/oauth/")) return false;
    this.prune();
    if (Date.now() - this.requestWindow.start > 60_000) this.requestWindow = { start: Date.now(), count: 0 };
    if (++this.requestWindow.count > 120) { res.writeHead(429, { "Retry-After": "60" }).end(); return true; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
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
    if (!details || details.uid !== uid || !isChatGptClient(details.params.client_id)) { res.writeHead(400).end("Invalid or expired login"); return; }
    if (req.method === "GET") {
      if (this.forms.size >= 32 && !this.forms.has(uid)) { res.writeHead(429).end("Try again later"); return; }
      const csrf = randomBytes(24).toString("base64url");
      this.forms.set(uid, { csrf, expires: Date.now() + LOGIN_TTL, attempts: 0 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RemoteAgent 연결 승인</title><h1>RemoteAgent 연결 승인</h1><p>ChatGPT에 이 서버의 Telegram 지시 읽기와 응답 전송을 허용합니다.</p><p>본인이 연결을 시작한 경우에만 Telegram의 /login dot에서 받은 5분 유효 코드를 입력하세요. 다른 사람이 요청한 코드를 전달하지 마세요.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>승인 코드 <input name="code" autocomplete="off" required maxlength="80"></label><button type="submit">연결 허용</button></form></html>`);
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
    if (!equal(input.get("csrf") ?? "", form.csrf) || !credential || credential.expires <= Date.now()) { res.writeHead(403).end("Invalid or expired approval code. Run /login dot again."); return; }
    this.codes.delete(key);
    this.forms.delete(uid);
    const clientId = String(details.params.client_id);
    const grant = details.grantId ? await this.provider.Grant.find(details.grantId) : new this.provider.Grant({ accountId: this.owner, clientId });
    if (!grant || (grant.accountId && grant.accountId !== this.owner)) { res.writeHead(403).end(); return; }
    grant.addOIDCScope(`openid offline_access ${SCOPE}`);
    grant.addResourceScope(this.resource, SCOPE);
    const grantId = await grant.save();
    await this.provider.interactionFinished(req, res, { login: { accountId: this.owner }, consent: { grantId } }, { mergeWithLastSubmission: false });
  }
  private prune() {
    for (const [key, value] of this.codes) if (value.expires <= Date.now()) this.codes.delete(key);
    for (const [key, value] of this.forms) if (value.expires <= Date.now()) this.forms.delete(key);
  }
}
