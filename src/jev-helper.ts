import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JevService } from "./services/jev-service.js";

export async function runJevCommand(args: string[], dataDir: string): Promise<void> {
  const service = new JevService(dataDir);
  if (args.length === 1 && args[0] === "status") {
    console.log(JSON.stringify(service.status()));
    return;
  }
  if (args.length !== 2 || args[0] !== "evaluate") throw new Error("Usage: remoteagent jev status | evaluate <request.json>");
  const file = await fs.open(args[1]!, "r");
  let request;
  try {
    const buffer = Buffer.alloc(32769);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 32768) throw new Error("Jev request exceeds 32 KiB.");
    try { request = JSON.parse(buffer.subarray(0, size).toString("utf8")); }
    catch { throw new Error("Invalid Jev request JSON."); }
  } finally { await file.close(); }
  console.log(JSON.stringify(await service.evaluate(request)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.REMOTEAGENT_DATA_DIR || process.env.DATA_DIR || path.join(os.homedir(), ".remoteagent");
  runJevCommand(process.argv.slice(2), dataDir).catch(() => {
    console.error("Jev tool failed. Check request JSON, file access and size; existing agent tools remain available.");
    process.exitCode = 1;
  });
}
