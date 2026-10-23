import type { IncomingMessage, ServerResponse } from "node:http";
import { G2_SCOPE, g2OriginAllowed, type G2Client, type G2Principal } from "./g2-config.js";
import type { G2RequestService } from "./g2-request-service.js";
import { G2_PCM_MAX_BYTES, type G2SpeechService } from "./g2-speech-service.js";

export class G2ApiService {
  private windows = new Map<string, { since: number; reads: number; writes: number }>();
  constructor(private readonly requests: G2RequestService, private readonly resource: string,
    private readonly clients: G2Client[], private readonly authenticate: (header: string | undefined) => Promise<G2Principal | undefined>,
    private readonly speech?: G2SpeechService) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", this.resource);
    if (url.pathname === "/.well-known/oauth-protected-resource/api/v1" && req.method === "GET") {
      this.json(res, 200, { resource: `${this.resource}/api/v1`, authorization_servers: [`${this.resource}/oauth`], scopes_supported: [G2_SCOPE] });
      return true;
    }
    if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) return false;
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Origin");
    const origin = req.headers.origin;
    if (origin && !this.clients.some(client => g2OriginAllowed(client, origin))) {
      this.json(res, 403, { error: "ORIGIN_NOT_ALLOWED" }); return true;
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS") {
      if (!origin || !["GET", "POST"].includes(String(req.headers["access-control-request-method"]))
        || String(req.headers["access-control-request-headers"] ?? "").split(",").some(header => header.trim() && !["authorization", "content-type"].includes(header.trim().toLowerCase()))) {
        this.json(res, 403, { error: "CORS_NOT_ALLOWED" }); return true;
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "300"); res.writeHead(204).end(); return true;
    }
    const principal = await this.authenticate(req.headers.authorization);
    if (!principal || !this.clients.some(client => client.clientId === principal.clientId && (!origin || g2OriginAllowed(client, origin)))) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${this.resource}/.well-known/oauth-protected-resource/api/v1", scope="${G2_SCOPE}"`);
      this.json(res, 401, { error: "UNAUTHORIZED" }); return true;
    }
    let window = this.windows.get(principal.clientId);
    if (!window || Date.now() - window.since >= 60000) {
      window = { since: Date.now(), reads: 0, writes: 0 }; this.windows.set(principal.clientId, window);
    }
    if (++window.reads > 120 || (req.method === "POST" && ++window.writes > 10)) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((window.since + 60000 - Date.now()) / 1000))));
      this.json(res, 429, { error: "RATE_LIMITED" }); return true;
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/v1/capabilities") {
        this.json(res, 200, { audio: { available: Boolean(this.speech), format: "s16le", sampleRate: 16000, channels: 1, maxSeconds: 60 } }); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/audio/transcriptions") {
        const targetId = url.searchParams.get("targetId");
        if (!(await this.requests.targets(principal)).some(t => t.targetId === targetId && t.type === "session")) throw Error("TARGET_FORBIDDEN");
        if (!this.speech) throw Error("SPEECH_UNAVAILABLE");
        if (req.headers["content-type"]?.split(";")[0] !== "audio/pcm") throw Error("PCM_REQUIRED");
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > G2_PCM_MAX_BYTES) throw Error("REQUEST_TOO_LARGE");
          chunks.push(Buffer.from(chunk));
        }
        const controller = new AbortController();
        const cancel = () => controller.abort(); res.once("close", cancel);
        try { this.json(res, 200, await this.speech.transcribe(Buffer.concat(chunks), controller.signal)); }
        finally { res.off("close", cancel); }
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/targets") {
        this.json(res, 200, { targets: await this.requests.targets(principal) }); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/requests") {
        const result = await this.requests.submit(principal, await this.body(req));
        res.setHeader("Location", `/api/v1/requests/${result.requestId}`);
        this.json(res, result.replayed ? 200 : 202, result); return true;
      }
      const match = /^\/api\/v1\/requests\/(req_[a-f0-9-]{36})(?:\/(events|cancel))?$/.exec(url.pathname);
      if (match && req.method === "GET" && !match[2]) {
        this.json(res, 200, this.requests.get(principal, match[1])); return true;
      }
      if (match && req.method === "GET" && match[2] === "events") {
        const after = url.searchParams.get("after") ?? "0", limit = url.searchParams.get("limit") ?? "100";
        if (!/^\d+$/.test(after) || !/^\d+$/.test(limit)) throw Error("INVALID_CURSOR");
        this.json(res, 200, this.requests.events(principal, match[1], Number(after), Number(limit))); return true;
      }
      if (match && req.method === "POST" && match[2] === "cancel") {
        if (Object.keys(await this.body(req)).length) throw Error("INVALID_REQUEST");
        const result = await this.requests.cancel(principal, match[1]);
        this.json(res, result.status === "cancel_requested" ? 202 : 200, result); return true;
      }
      this.json(res, 404, { error: "NOT_FOUND" }); return true;
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "REQUEST_FAILED";
      const status = code === "UNAUTHORIZED" ? 401 : code === "TARGET_FORBIDDEN" ? 403
        : ["TARGET_NOT_FOUND", "REQUEST_NOT_FOUND"].includes(code) ? 404 : code === "CURSOR_EXPIRED" ? 410
        : ["REQUEST_ID_CONFLICT", "TARGET_BUSY", "TARGET_UNAVAILABLE", "DOT_NOT_SUBSCRIBED"].includes(code) ? 409
        : ["REQUEST_CAPACITY", "G2_STORAGE_FAILED", "SPEECH_UNAVAILABLE", "SPEECH_BUSY"].includes(code) ? 503 : code === "REQUEST_TOO_LARGE" ? 413
        : ["JSON_REQUIRED", "PCM_REQUIRED"].includes(code) ? 415 : code === "SPEECH_FAILED" ? 502 : 400;
      this.json(res, status, { error: code }); return true;
    }
  }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw Error("JSON_REQUIRED");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw Error("REQUEST_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw Error("INVALID_JSON"); }
    if (!body || Array.isArray(body) || typeof body !== "object") throw Error("INVALID_REQUEST");
    return body as Record<string, unknown>;
  }
  private json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data));
  }
}
