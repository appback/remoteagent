import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

// G2 keeps the existing HTTPS ingress without starting a dot bridge or MCP tools.
export class G2ServerService {
  private server?: http.Server;
  private active = 0;
  constructor(private readonly auth: Handler, private readonly api: Handler) {}

  async start(port: number): Promise<void> {
    this.server = http.createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (this.active >= 8) {
        res.setHeader("Retry-After", "3");
        res.writeHead(429).end(); return;
      }
      this.active++;
      void (async () => {
        if (await this.auth(req, res) || await this.api(req, res)) return;
        res.writeHead(404).end();
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }).finally(() => { this.active--; });
    });
    this.server.maxConnections = 32;
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.off("error", reject); resolve();
      });
    });
  }
  address() { return this.server?.address(); }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server
      ? this.server.close(error => error ? reject(error) : resolve()) : resolve());
  }
}
