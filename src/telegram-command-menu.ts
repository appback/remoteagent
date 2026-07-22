import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TELEGRAM_COMMAND_MENU = [
  { command: "start", description: "Start a new Codex or Claude session" },
  { command: "list", description: "List sessions" },
  { command: "new", description: "Start a fresh session" },
  { command: "switch", description: "Switch to a session" },
  { command: "plan", description: "Reinforce planning documents" },
  { command: "status", description: "Show current session status" },
  { command: "attach", description: "Attach an existing provider session" },
  { command: "state", description: "Show or edit session state notes" },
  { command: "option", description: "Show or change runtime options" },
  { command: "secret", description: "Store or manage hidden secret values" },
  { command: "docs", description: "Pin or find session documents" },
  { command: "macro", description: "Save or run reusable instructions" },
  { command: "model", description: "Show or change provider model" },
  { command: "stop", description: "Stop active work and clear queued messages" },
  { command: "sandbox", description: "Set Codex sandbox mode" },
  { command: "batch", description: "Collect and send a multi-message batch" },
  { command: "artifacts", description: "List or clean uploaded artifacts" },
  { command: "cleanup", description: "Clean current session workspace" },
  { command: "bots", description: "List configured Telegram bots" },
  { command: "bot", description: "Manage Telegram bots" },
  { command: "install", description: "Install or update Codex or Claude" },
  { command: "login", description: "Run provider login flow" },
  { command: "reset", description: "Clear this chat binding" },
  { command: "help", description: "Show command help" },
];

export async function setTelegramCommandMenu(token: string): Promise<void> {
  await callTelegramCommandApi(token, "setMyCommands", {
    commands: TELEGRAM_COMMAND_MENU,
  });
}

export async function deleteTelegramCommandMenu(token: string): Promise<void> {
  await callTelegramCommandApi(token, "deleteMyCommands", {});
}

async function callTelegramCommandApi(token: string, method: string, payload: unknown): Promise<void> {
  let stdout: string;
  let stderr: string | undefined;

  try {
    const result = await execFileAsync("curl", [
      "-sS",
      "-4",
      "--max-time",
      "20",
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(payload),
      `https://api.telegram.org/bot${token}/${method}`,
    ]);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    throw new Error(`Telegram ${method} curl failed: ${formatCurlError(error)}`);
  }

  if (stderr?.trim()) {
    console.error(`curl stderr for ${method}: ${stderr.trim()}`);
  }

  const parsed = JSON.parse(stdout) as { ok?: boolean; description?: string };
  if (!parsed.ok) {
    throw new Error(parsed.description || `Telegram ${method} failed.`);
  }
}

function formatCurlError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "").trim()
    : "";

  return [code ? `code=${code}` : undefined, stderr || error.message]
    .filter(Boolean)
    .join(" ");
}
