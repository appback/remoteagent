import fs from "node:fs";

export const G2_SCOPE = "remoteagent:g2";
export type G2Client = { clientId: string; redirectUris: string[]; origins: string[]; targetIds: string[] };
export type G2Principal = { subject: string; clientId: string; expiresAt: number; targetIds: string[] };

// Operator-managed allowlist. Merely installing the package grants no G2 access.
export function readG2Clients(file: string | undefined): G2Client[] {
  if (!file) throw Error("G2_CONFIG_REQUIRED");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as { clients?: G2Client[] };
  if (!Array.isArray(config.clients) || !config.clients.length || config.clients.length > 8) throw Error("G2_CONFIG_INVALID");
  const seen = new Set<string>();
  for (const client of config.clients) {
    if (!client || !/^remoteagent-g2-[a-z0-9_-]{1,48}$/.test(client.clientId) || seen.has(client.clientId)
      || !Array.isArray(client.origins) || !client.origins.length || client.origins.length > 4
      || !Array.isArray(client.redirectUris) || !client.redirectUris.length || client.redirectUris.length > 4
      || !Array.isArray(client.targetIds) || client.targetIds.length > 100
      || client.targetIds.some(id => typeof id !== "string" || !/^tgt_[a-f0-9]{32}$/.test(id))) throw Error("G2_CONFIG_INVALID");
    seen.add(client.clientId);
    for (const origin of client.origins) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw Error("G2_ORIGIN_INVALID");
    }
    for (const redirect of client.redirectUris) {
      const url = new URL(redirect);
      if (!client.origins.includes(url.origin) || url.username || url.password || url.search || url.hash
        || /[\s;'"<>]/.test(redirect)) throw Error("G2_REDIRECT_INVALID");
    }
  }
  return config.clients;
}
