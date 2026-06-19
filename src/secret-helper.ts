#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { readSecretValue, writeSecretValue } from "./services/agent-memory-service.js";

async function main(): Promise<void> {
  const [command, key] = process.argv.slice(2);
  if (!["get", "set"].includes(command ?? "") || !key) {
    process.stderr.write("Usage: secret-helper get <KEY>\n       secret-helper set <KEY>  # reads value from stdin\n");
    process.exitCode = 2;
    return;
  }

  const dataDir = process.env.REMOTEAGENT_DATA_DIR?.trim()
    || process.env.DATA_DIR?.trim()
    || path.join(os.homedir(), ".remoteagent");

  if (command === "set") {
    const value = await readStdin();
    if (!value) {
      process.stderr.write("Secret value was empty.\n");
      process.exitCode = 2;
      return;
    }
    writeSecretValue(dataDir, key.trim(), value);
    process.stdout.write(`Stored secret: ${key.trim()}\n`);
    return;
  }

  const value = readSecretValue(dataDir, key.trim());
  if (!value) {
    process.stderr.write(`Secret was not found: ${key}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

void main();
