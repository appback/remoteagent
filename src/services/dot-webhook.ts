import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(ip, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicDotAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  return isIP(address) === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export type DotWebhookResult = { status: number; body: string; retryAfterMs?: number };
export type DotWebhookPost = (url: string, secret: string, subscriptionId: string,
  eventId: string, body: string, previousSecret?: string) => Promise<DotWebhookResult>;

export function dotWebhookHeaders(secret: string, subscriptionId: string, eventId: string,
  body: string, timestamp = Math.floor(Date.now() / 1000), previousSecret?: string): Record<string, string> {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw Error("INVALID_SIGNING_SECRET");
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 24 || key.length > 64) throw Error("INVALID_SIGNING_SECRET");
  const signature = createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64");
  const headers = {
    "content-type": "application/json", "webhook-id": eventId,
    "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}`,
    "X-MCP-Subscription-Id": subscriptionId,
  };
  if (previousSecret) headers["webhook-signature"] += " "
    + dotWebhookHeaders(previousSecret, subscriptionId, eventId, body, timestamp)["webhook-signature"];
  return headers;
}

export function createDotWebhookPost(allowedHosts: string[],
  resolveHost = (hostname: string) => lookup(hostname, { all: true }),
  requestHttps = https.request): DotWebhookPost {
  const hosts = new Set(allowedHosts.map(host => host.trim().toLowerCase()));
  return async (destination, secret, subscriptionId, eventId, body, previousSecret) => {
    const deadline = Date.now() + 10000;
    const url = new URL(destination);
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || (url.port && url.port !== "443")) {
      throw Error("CALLBACK_NOT_ALLOWED");
    }
    if (!hosts.has(url.hostname.toLowerCase())) throw Error(`CALLBACK_HOST_NOT_ALLOWED: ${url.hostname}`);
    if (Buffer.byteLength(body) > 256 * 1024) throw Error("EVENT_TOO_LARGE");
    // Pin the validated resolution to this connection; never follow redirects.
    const addresses = await new Promise<Awaited<ReturnType<typeof resolveHost>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("CALLBACK_TIMEOUT")), Math.max(1, deadline - Date.now()));
      Promise.resolve().then(() => resolveHost(url.hostname)).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    if (!addresses.length || addresses.some(item => !isPublicDotAddress(item.address))) {
      throw Error("CALLBACK_ADDRESS_NOT_PUBLIC");
    }
    const selected = addresses[0];
    return new Promise<DotWebhookResult>((resolve, reject) => {
      const options: https.RequestOptions & { autoSelectFamily: boolean } = {
        method: "POST", agent: false, family: selected.family, autoSelectFamily: false,
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        headers: dotWebhookHeaders(secret, subscriptionId, eventId, body, undefined, previousSecret),
      };
      const request = requestHttps(url, options, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) { response.destroy(Error("CALLBACK_RESPONSE_TOO_LARGE")); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const retrySeconds = Number(response.headers["retry-after"]);
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"),
            retryAfterMs: Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : undefined });
        });
      });
      const timeout = setTimeout(() => request.destroy(Error("CALLBACK_TIMEOUT")), Math.max(1, deadline - Date.now()));
      request.on("close", () => clearTimeout(timeout));
      request.on("error", reject);
      request.end(body);
    });
  };
}
