import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  fetchTelegramBotIdentity,
  registerTelegramBot,
  readConfiguredOwnerId,
  waitForTelegramOwner,
} from "./services/cli-config-service.js";
import { exportSecrets, importSecrets } from "./services/secret-transfer-service.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await import("./index.js");
    return;
  }
  if (["help", "--help", "-h"].includes(args[0]!)) {
    printHelp();
    return;
  }

  const dataDir = path.resolve(takeOption(args, "--data-dir") || process.env.DATA_DIR?.trim() || path.join(os.homedir(), ".remoteagent"));
  const [group, action] = args;
  if (group === "bot" && action === "add") {
    await addBot(dataDir, args.slice(2));
    return;
  }
  if (group === "secret" && action === "export") {
    await exportSecretCommand(dataDir, args.slice(2));
    return;
  }
  if (group === "secret" && action === "import") {
    await importSecretCommand(dataDir, args.slice(2));
    return;
  }

  throw new Error(`Unknown command: ${args.join(" ")}\n\nRun 'remoteagent --help' for usage.`);
}

async function addBot(dataDir: string, args: string[]): Promise<void> {
  const ownerOption = takeOption(args, "--owner");
  const tokenFile = takeOption(args, "--token-file");
  if (args.some((arg) => arg.startsWith("--"))) {
    throw new Error(`Unknown bot option: ${args.find((arg) => arg.startsWith("--"))}`);
  }
  if (tokenFile && args[0]) {
    throw new Error("Provide the bot token either as an argument or with --token-file, not both.");
  }

  const token = tokenFile
    ? await readSingleLineFile(tokenFile)
    : args.shift() || await promptHidden("Telegram bot token: ");
  if (args.length > 0) {
    throw new Error(`Unexpected bot argument: ${args[0]}`);
  }

  const identity = await fetchTelegramBotIdentity(token);
  const configuredOwner = await readConfiguredOwnerId(dataDir);
  let ownerId = ownerOption || configuredOwner;
  if (!ownerId) {
    const startPayload = `ra_${randomBytes(8).toString("hex")}`;
    console.log([
      `Validated @${identity.username} (${identity.id}).`,
      "",
      "Open this Telegram link within 3 minutes to confirm the owner:",
      `  https://t.me/${identity.username}?start=${startPayload}`,
      "",
      "Or send this exact command to the bot:",
      `  /start ${startPayload}`,
      "",
      "Waiting for owner confirmation...",
    ].join("\n"));
    const owner = await waitForTelegramOwner(token, startPayload);
    ownerId = owner.id;
    console.log(`Detected Telegram owner: ${owner.displayName}${owner.username ? ` (@${owner.username})` : ""} (${owner.id})`);
  }
  const result = await registerTelegramBot({ dataDir, token, ownerId, identity });

  console.log([
    `${result.added ? "Registered" : "Updated"} @${result.identity.username} (${result.identity.id}).`,
    `Configured bots: ${result.botCount}`,
    `Configuration: ${result.envPath}`,
    "Start or restart RemoteAgent to apply it:",
    "  remoteagent-start",
    "  # systemd runtime: sudo systemctl restart remoteagent",
  ].join("\n"));
}

async function exportSecretCommand(dataDir: string, args: string[]): Promise<void> {
  const passphraseFile = takeOption(args, "--passphrase-file");
  if (args.some((arg) => arg.startsWith("--"))) {
    throw new Error(`Unknown secret export option: ${args.find((arg) => arg.startsWith("--"))}`);
  }
  const outputPath = args.shift() || path.resolve(`remoteagent-secrets-${formatDate(new Date())}.ra-secrets`);
  if (args.length > 0) {
    throw new Error(`Unexpected secret export argument: ${args[0]}`);
  }
  const passphrase = passphraseFile
    ? await readSingleLineFile(passphraseFile)
    : await promptConfirmedPassphrase();
  const result = await exportSecrets(dataDir, outputPath, passphrase);
  console.log([
    `Exported ${result.count} secret(s) to ${result.outputPath}.`,
    "The bundle is encrypted. Transfer it together with neither the passphrase nor the source secret store.",
  ].join("\n"));
}

async function importSecretCommand(dataDir: string, args: string[]): Promise<void> {
  const passphraseFile = takeOption(args, "--passphrase-file");
  const replace = takeFlag(args, "--replace");
  if (args.some((arg) => arg.startsWith("--"))) {
    throw new Error(`Unknown secret import option: ${args.find((arg) => arg.startsWith("--"))}`);
  }
  const inputPath = args.shift();
  if (!inputPath) {
    throw new Error("Usage: remoteagent secret import <file> [--replace]");
  }
  if (args.length > 0) {
    throw new Error(`Unexpected secret import argument: ${args[0]}`);
  }
  const passphrase = passphraseFile
    ? await readSingleLineFile(passphraseFile)
    : await promptHidden("Secret bundle passphrase: ");
  const result = await importSecrets(dataDir, inputPath, passphrase, replace);
  console.log([
    `Imported ${result.imported} secret(s); overwritten=${result.overwritten}; total=${result.total}.`,
    result.backupPath ? `Previous secret store backup: ${result.backupPath}` : "No previous secret store required a backup.",
    "Secret values were not printed.",
  ].join("\n"));
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("Interactive hidden input requires a TTY. Use the corresponding --*-file option instead.");
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function promptConfirmedPassphrase(): Promise<string> {
  const first = await promptHidden("Secret bundle passphrase: ");
  const second = await promptHidden("Confirm passphrase: ");
  if (first !== second) {
    throw new Error("Passphrases did not match.");
  }
  return first;
}

async function readSingleLineFile(filePath: string): Promise<string> {
  const value = await fs.readFile(path.resolve(filePath), "utf8");
  return value.replace(/[\r\n]+$/, "");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function printHelp(): void {
  console.log(`RemoteAgent CLI

Usage:
  remoteagent                         Start the foreground runtime
  remoteagent bot add [token] [--owner <telegram-user-id>]
  remoteagent bot add --token-file <file> --owner <telegram-user-id>
  remoteagent secret export [file] [--passphrase-file <file>]
  remoteagent secret import <file> [--replace] [--passphrase-file <file>]

Global option:
  --data-dir <path>                   Default: ~/.remoteagent

Security:
  Omit tokens and passphrases for hidden interactive prompts. File options are
  intended for automation and keep sensitive values out of shell history.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`RemoteAgent CLI error: ${message}`);
  process.exitCode = 1;
});
