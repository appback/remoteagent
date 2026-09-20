import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildProviderEnv } from "../adapters/runtime-env.js";
const exec = promisify(execFile);

export async function requestSelfUpdate(dataDir: string, token: string, chatId: number): Promise<string> {
  const env = buildProviderEnv({});
  try { await exec("systemctl", ["--user", "is-active", "--quiet", "remoteagent"], { env, timeout: 5000 }); }
  catch { throw new Error("Self-update requires an active user service. Run remoteagent service migrate first."); }
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "bot-polling-state.json"), "utf8"));
  if (Object.values(state.bots ?? {}).some((b: any) => b.runningSessionIds?.length)) throw new Error("Active provider work exists. Retry /install remoteagent after completion.");
  const pending = path.join(dataDir, "self-update.json");
  const handle = await fs.open(pending, "wx", 0o600).catch(() => { throw new Error("A self-update is pending. Check the user service journal before retrying."); });
  try {
    await handle.writeFile(JSON.stringify({ token, chatId, requestedAt: new Date().toISOString() }));
    await handle.close();
    const script = fileURLToPath(new URL("../../scripts/self-update.mjs", import.meta.url));
    await exec("systemd-run", ["--user", "--unit", `remoteagent-update-${Date.now()}`, "--collect", "--service-type=exec",
      process.execPath, script, dataDir], { env, cwd: os.homedir(), timeout: 10000 });
    return "RemoteAgent update requested. The worker will check npm, update only when idle, and report the result here.";
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(pending, { force: true });
    throw error;
  }
}
