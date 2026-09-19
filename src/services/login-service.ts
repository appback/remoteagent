import { spawn } from "node:child_process";
import os from "node:os";
import { buildProviderEnv } from "../adapters/runtime-env.js";

export type LoginTarget = "github" | "codex" | "claude";
export class MissingLoginToolError extends Error {}
type Notice = (text: string) => Promise<void>;
const commands = {
  github: { bin: "gh", status: ["auth", "status", "--hostname", "github.com"], login: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"] },
  codex: { bin: "codex", status: ["login", "status"], login: ["login", "--device-auth"] },
  claude: { bin: "claude", status: ["auth", "status"], login: ["auth", "login"] },
};

// Shared across Telegram bots: authentication belongs to the OS account, not a chat.
const active = new Set<LoginTarget>();

export function loginHints(raw: string): string | undefined {
  const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const urls = [...new Set(text.match(/https?:\/\/[^\s<>"\x1b]+/g) ?? [])];
  if (!urls.length) return undefined;
  const code = text.match(/(?:one[- ]time|device) code[^\n]*?\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/i)?.[1]
    ?? text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/)?.[1];
  return [...urls, ...(code ? [`One-time code: ${code}`] : [])].join("\n");
}

export class LoginService {
  constructor(
    private readonly lifetimeMs = 15 * 60_000,
    private readonly binaries: Partial<Record<LoginTarget, string>> = {},
  ) {}

  async isInstalled(target: LoginTarget): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaries[target] ?? commands[target].bin, ["--version"], { cwd: os.homedir(), env: buildProviderEnv({}) });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end();
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === "ENOENT") resolve(false);
        else reject(new Error(`${commands[target].bin}: ${error.code}. Check execution permissions.`));
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve(true);
        else reject(new Error(`${commands[target].bin} --version failed (exit=${code}).`));
      });
    });
  }

  private unavailable(target: LoginTarget): string {
    const guidance = target === "github" ? "Install GitHub CLI (gh) on this server."
      : `Run /install ${target} first.`;
    return `${commands[target].bin} could not start. ${guidance} If installed, check execution permissions.`;
  }

  async status(target: LoginTarget): Promise<boolean> {
    const command = commands[target];
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaries[target] ?? command.bin, command.status, { cwd: os.homedir(), env: buildProviderEnv({}) });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.stdout.on("data", chunk => { output = (output + chunk).slice(-16_384); });
      child.stderr.resume();
      child.stdin.end();
      child.on("error", () => { clearTimeout(timer); reject(new Error(this.unavailable(target))); });
      child.on("close", code => {
        clearTimeout(timer);
        if (target === "claude") {
          try { resolve(code === 0 && JSON.parse(output).loggedIn === true); } catch { resolve(false); }
        } else resolve(code === 0);
      });
    });
  }

  async start(target: LoginTarget, force: boolean, notify: Notice): Promise<{ alreadyLoggedIn: boolean; text: string }> {
    if (active.has(target)) return { alreadyLoggedIn: false, text: `${target} login is already in progress on this machine.` };
    active.add(target);
    try {
      if (!await this.isInstalled(target)) throw new MissingLoginToolError(`${commands[target].bin} is not installed on this server.`);
      if (!force && await this.status(target)) {
        active.delete(target);
        return { alreadyLoggedIn: true, text: `${target} is already authenticated for OS account ${os.userInfo().username}.` };
      }
    } catch (error) { active.delete(target); throw error; }

    const command = commands[target];
    return new Promise(resolve => {
      const child = spawn(this.binaries[target] ?? command.bin, command.login, {
        cwd: os.homedir(), env: buildProviderEnv({ BROWSER: "echo", GH_BROWSER: "echo" }),
      });
      const stopOnExit = () => { child.kill("SIGKILL"); };
      process.once("exit", stopOnExit);
      let raw = "";
      let delivered = "";
      let settled = false;
      let expired = false;
      let notifications = Promise.resolve();
      const send = (text: string) => { notifications = notifications.then(() => notify(text)).catch(() => undefined); };
      const finishStart = (text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(initialTimer);
        resolve({ alreadyLoggedIn: false, text });
      };
      const initialTimer = setTimeout(() => finishStart(`${target} login is waiting for an authentication URL. Completion or expiry will be reported here.`), 20_000);
      const expiryTimer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, this.lifetimeMs);
      const consume = (chunk: Buffer) => {
        raw = (raw + chunk.toString()).slice(-32_768);
        const hints = loginHints(raw);
        if (hints && hints !== delivered) {
          delivered = hints;
          const message = `${target} login (${os.userInfo().username}@${os.hostname()})\n${hints}\nComplete authentication in your browser. Existing sessions remain unchanged.`;
          if (settled) send(message); else finishStart(message);
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.stdin.on("error", () => undefined);
      child.stdin.end("\n");
      child.on("error", () => finishStart(this.unavailable(target)));
      child.on("close", async code => {
        process.removeListener("exit", stopOnExit);
        clearTimeout(expiryTimer);
        try {
          const authenticated = !expired && code === 0 && await this.status(target).catch(() => false);
          const message = authenticated ? `${target} login completed and authentication verified.`
            : expired ? `${target} login expired after ${Math.round(this.lifetimeMs / 60_000)} minutes. Run /login to retry.`
              : `${target} login did not complete (exit=${code}). Authentication was not confirmed. Run /login to retry.`;
          if (settled) send(message); else finishStart(message);
        } finally { active.delete(target); }
      });
    });
  }
}
