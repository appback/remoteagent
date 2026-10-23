import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function acquireProcessLock(dataDir: string): Promise<string> {
  await fsp.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "remoteagent.lock");
  const claim = path.join(dataDir, `.runtime-claim.${randomUUID()}`);
  const temp = path.join(dataDir, `remoteagent.pid.${randomUUID()}.tmp`);
  fs.writeFileSync(claim, String(process.pid), { mode: 0o600, flag: "wx" });
  let owned = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Publish a complete ownership record atomically, never an empty lock file.
      try { fs.linkSync(claim, lockPath); owned = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const owner = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (Number.isSafeInteger(owner) && owner > 1 && alive(owner)) throw Error(`RemoteAgent is already running with PID ${owner}.`);
      if ((!Number.isSafeInteger(owner) || owner < 2) && Date.now() - fs.statSync(lockPath).mtimeMs < 30000)
        throw Error("RemoteAgent lock is initializing; retry later without replacing its PID.");
      // Serialize stale-lock recovery; competing starts must not unlink a new owner.
      const recovery = lockPath + ".recovery";
      const fd = fs.openSync(recovery, "wx", 0o600);
      try {
        const current = Number(fs.readFileSync(lockPath, "utf8").trim());
        if (Number.isSafeInteger(current) && current > 1 && alive(current)) throw Error(`RemoteAgent is already running with PID ${current}.`);
        fs.rmSync(lockPath);
      } finally { fs.closeSync(fd); fs.rmSync(recovery, { force: true }); }
    }
    if (!owned) throw Error("RemoteAgent could not acquire its process lock.");
    try {
      await fsp.writeFile(temp, String(process.pid) + "\n", { mode: 0o600, flag: "wx" });
      await fsp.rename(temp, path.join(dataDir, "remoteagent.pid"));
      return lockPath;
    } catch (error) {
      await fsp.rm(lockPath, { force: true }); throw error;
    }
  } finally { fs.rmSync(claim, { force: true }); fs.rmSync(temp, { force: true }); }
}

export function releaseProcessLock(lockPath: string): void {
  for (const file of [lockPath, path.join(path.dirname(lockPath), "remoteagent.pid")]) {
    try { if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.rmSync(file, { force: true }); }
    catch { /* Never remove another process's ownership record. */ }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
