#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { readSecretValue } from "./services/agent-memory-service.js";

function main(): void {
  const [command, key] = process.argv.slice(2);
  if (command !== "get" || !key) {
    process.stderr.write("Usage: secret-helper get <KEY>\n");
    process.exitCode = 2;
    return;
  }

  const dataDir = process.env.REMOTEAGENT_DATA_DIR?.trim()
    || process.env.DATA_DIR?.trim()
    || path.join(os.homedir(), ".remoteagent");
  const value = readSecretValue(dataDir, key.trim());
  if (!value) {
    process.stderr.write(`Secret was not found: ${key}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(value);
}

main();
