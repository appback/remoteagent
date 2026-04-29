import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

type ManagedBot = {
  index: number;
  token: string;
  id: number;
  username: string;
};

type PendingBotOperationAction = "add" | "remove" | "reload";
type PendingBotOperationStatus = "pending" | "rolled_back";

type PendingBotOperation = {
  version: 1;
  action: PendingBotOperationAction;
  status: PendingBotOperationStatus;
  requestedAt: string;
  chatId: number;
  replyToken: string;
  notifyViaUsername?: string;
  sourceBotId: string;
  target?: {
    id: number;
    username: string;
  };
  backupEnvPath: string;
  reason?: string;
};

type EnvConfig = {
  lines: string[];
  tokens: string[];
  usernames: string[];
};

type BotCommandResult = {
  message: string;
};

type TelegramGetMeResponse = {
  ok?: boolean;
  description?: string;
  result?: {
    id: number;
    username?: string;
  };
};

const execFileAsync = promisify(execFile);

export class BotManagementService {
  private readonly envPath: string;
  private readonly pendingPath: string;
  private readonly backupsDir: string;

  constructor(
    private readonly dataDir: string,
    private readonly serviceName: string,
    private readonly restartHelperPath: string,
  ) {
    this.envPath = path.join(this.dataDir, ".env");
    this.pendingPath = path.join(this.dataDir, "pending-bot-operation.json");
    this.backupsDir = path.join(this.dataDir, "backups");
  }

  async listBots(): Promise<string> {
    const bots = await this.listConfiguredBots();
    if (bots.length === 0) {
      return "No Telegram bots are configured.";
    }

    return [
      `Configured bots (${bots.length})`,
      ...bots.map((bot, index) => `${index + 1}. @${bot.username} (${bot.id})`),
    ].join("\n");
  }

  async addBot(token: string, sourceBotId: string, sourceBotToken: string, chatId: number): Promise<BotCommandResult> {
    await this.ensureSupported();

    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Usage: /bot add <token>");
    }

    const target = await this.fetchBotIdentity(trimmed);
    const env = await this.readEnvConfig();
    if (env.tokens.includes(trimmed)) {
      throw new Error(`@${target.username} is already configured.`);
    }
    if (env.tokens.some((existing) => this.tokenId(existing) === target.id)) {
      throw new Error(`A bot with id ${target.id} is already configured.`);
    }
    if (env.usernames.some((username) => username.toLowerCase() === target.username.toLowerCase())) {
      throw new Error(`@${target.username} is already configured.`);
    }

    const tokens = [...env.tokens, trimmed];
    const usernames = [...env.usernames, target.username];
    const backupEnvPath = await this.backupEnv();
    const pending: PendingBotOperation = {
      version: 1,
      action: "add",
      status: "pending",
      requestedAt: new Date().toISOString(),
      chatId,
      replyToken: sourceBotToken,
      notifyViaUsername: sourceBotId,
      sourceBotId,
      target: {
        id: target.id,
        username: target.username,
      },
      backupEnvPath,
    };

    try {
      await this.writePendingOperation(pending);
      await this.writeEnvConfig(env.lines, tokens, usernames);
      await this.launchRestartJob();
    } catch (error) {
      await this.restoreBackup(backupEnvPath).catch(() => undefined);
      await this.clearPendingOperation().catch(() => undefined);
      throw error;
    }

    return {
      message: [
        `Applying bot add for @${target.username} (${target.id}).`,
        "The runtime will restart once and then report the result here.",
      ].join("\n\n"),
    };
  }

  async removeBot(selector: string, sourceBotId: string, sourceBotToken: string, chatId: number): Promise<BotCommandResult> {
    await this.ensureSupported();

    const trimmed = selector.trim();
    if (!trimmed) {
      throw new Error("Usage: /bot remove <username|id>");
    }

    const env = await this.readEnvConfig();
    const bots = this.zipBots(env.tokens, env.usernames);
    const target = this.resolveBotSelector(bots, trimmed);
    if (!target) {
      throw new Error(`Bot was not found: ${trimmed}`);
    }
    if (bots.length <= 1) {
      throw new Error("Cannot remove the last configured bot.");
    }

    const remainingBots = bots.filter((value) => value.token !== target.token);
    const tokens = remainingBots.map((value) => value.token);
    const usernames = remainingBots.map((value) => value.username);
    const replyToken = tokens.includes(sourceBotToken) ? sourceBotToken : tokens[0]!;
    const notifyViaUsername = remainingBots.find((bot) => bot.token === replyToken)?.username;
    const backupEnvPath = await this.backupEnv();
    const pending: PendingBotOperation = {
      version: 1,
      action: "remove",
      status: "pending",
      requestedAt: new Date().toISOString(),
      chatId,
      replyToken,
      notifyViaUsername,
      sourceBotId,
      target: {
        id: target.id,
        username: target.username,
      },
      backupEnvPath,
    };

    try {
      await this.writePendingOperation(pending);
      await this.writeEnvConfig(env.lines, tokens, usernames);
      await this.launchRestartJob();
    } catch (error) {
      await this.restoreBackup(backupEnvPath).catch(() => undefined);
      await this.clearPendingOperation().catch(() => undefined);
      throw error;
    }

    const notifyLine = replyToken === sourceBotToken || !notifyViaUsername
      ? "The runtime will restart once and then report the result here."
      : `The runtime will restart once and then report the result through @${notifyViaUsername}.`;

    return {
      message: [
        `Applying bot removal for @${target.username} (${target.id}).`,
        notifyLine,
      ].join("\n\n"),
    };
  }

  async reloadBots(sourceBotId: string, sourceBotToken: string, chatId: number): Promise<BotCommandResult> {
    await this.ensureSupported();
    const backupEnvPath = await this.backupEnv();
    const pending: PendingBotOperation = {
      version: 1,
      action: "reload",
      status: "pending",
      requestedAt: new Date().toISOString(),
      chatId,
      replyToken: sourceBotToken,
      notifyViaUsername: sourceBotId,
      sourceBotId,
      backupEnvPath,
    };

    try {
      await this.writePendingOperation(pending);
      await this.launchRestartJob();
    } catch (error) {
      await this.clearPendingOperation().catch(() => undefined);
      throw error;
    }

    return {
      message: "Restarting the runtime now. I will report the result here after it comes back.",
    };
  }

  async reportPendingOperationResult(): Promise<void> {
    const pending = await this.readPendingOperation();
    if (!pending) {
      return;
    }

    const bots = await this.listConfiguredBots().catch(() => []);
    const listLines = bots.length > 0
      ? bots.map((bot) => `- @${bot.username} (${bot.id})`)
      : ["- none"];

    const lines = pending.status === "rolled_back"
      ? [
        "Bot configuration failed and was rolled back.",
        `Action: ${pending.action}`,
        pending.target ? `Target: @${pending.target.username} (${pending.target.id})` : undefined,
        pending.reason ? `Reason: ${pending.reason}` : undefined,
        "Current configured bots:",
        ...listLines,
      ]
      : [
        "Bot configuration applied successfully.",
        `Action: ${pending.action}`,
        pending.target ? `Target: @${pending.target.username} (${pending.target.id})` : undefined,
        "Current configured bots:",
        ...listLines,
      ];

    try {
      await this.sendTelegramMessage(pending.replyToken, pending.chatId, lines.filter(Boolean).join("\n"));
      await this.clearPendingOperation();
      await fs.rm(pending.backupEnvPath, { force: true }).catch(() => undefined);
    } catch (error) {
      console.error("Failed to report pending bot operation result:", error);
    }
  }

  private async ensureSupported(): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("Bot management restart is not supported on this Windows runtime.");
    }

    await fs.access(this.restartHelperPath).catch(() => {
      throw new Error(`Restart helper is missing: ${this.restartHelperPath}`);
    });
  }

  private async launchRestartJob(): Promise<void> {
    const { stderr } = await execFileAsync("sudo", [
      "-n",
      "systemd-run",
      "--unit",
      "remoteagent-bot-op",
      "--replace",
      "--collect",
      "--service-type=exec",
      this.restartHelperPath,
      this.serviceName,
      this.dataDir,
    ]);

    const output = stderr?.trim();
    if (output) {
      console.error("bot restart helper stderr:", output);
    }
  }

  private async fetchBotIdentity(token: string): Promise<ManagedBot> {
    const url = `https://api.telegram.org/bot${token}/getMe`;
    const { stdout, stderr } = await execFileAsync("curl", ["-sS", "--max-time", "20", url]);
    if (stderr?.trim()) {
      console.error("curl stderr for getMe:", stderr.trim());
    }

    const payload = JSON.parse(stdout) as TelegramGetMeResponse;
    if (!payload.ok || !payload.result?.id || !payload.result.username) {
      throw new Error(payload.description || "Telegram getMe failed for the supplied bot token.");
    }

    return {
      index: 0,
      token,
      id: payload.result.id,
      username: payload.result.username,
    };
  }

  private async readEnvConfig(): Promise<EnvConfig> {
    const text = await fs.readFile(this.envPath, "utf8");
    const lines = text.split(/\r?\n/);
    const tokenLine = lines.find((line) => line.startsWith("TELEGRAM_BOT_TOKENS="));
    const singleTokenLine = lines.find((line) => line.startsWith("TELEGRAM_BOT_TOKEN="));
    const usernameLine = lines.find((line) => line.startsWith("TELEGRAM_BOT_USERNAMES="));

    const tokens = tokenLine
      ? this.parseCsv(tokenLine.slice("TELEGRAM_BOT_TOKENS=".length))
      : singleTokenLine
        ? [singleTokenLine.slice("TELEGRAM_BOT_TOKEN=".length).trim()].filter(Boolean)
        : [];
    const usernames = usernameLine ? this.parseCsv(usernameLine.slice("TELEGRAM_BOT_USERNAMES=".length)) : [];

    return {
      lines,
      tokens,
      usernames,
    };
  }

  private async writeEnvConfig(originalLines: string[], tokens: string[], usernames: string[]): Promise<void> {
    const normalizedUsernames = this.normalizeUsernames(tokens, usernames);
    const nextLines: string[] = [];
    let hasMulti = false;
    let hasSingle = false;
    let hasUsernames = false;

    for (const line of originalLines) {
      if (line.startsWith("TELEGRAM_BOT_TOKENS=")) {
        nextLines.push(`TELEGRAM_BOT_TOKENS=${tokens.join(",")}`);
        hasMulti = true;
        continue;
      }
      if (line.startsWith("TELEGRAM_BOT_TOKEN=")) {
        nextLines.push(`TELEGRAM_BOT_TOKEN=${tokens[0] ?? ""}`);
        hasSingle = true;
        continue;
      }
      if (line.startsWith("TELEGRAM_BOT_USERNAMES=")) {
        nextLines.push(`TELEGRAM_BOT_USERNAMES=${normalizedUsernames.join(",")}`);
        hasUsernames = true;
        continue;
      }
      nextLines.push(line);
    }

    if (!hasMulti) {
      nextLines.unshift(`TELEGRAM_BOT_TOKENS=${tokens.join(",")}`);
    }
    if (!hasSingle) {
      nextLines.unshift(`TELEGRAM_BOT_TOKEN=${tokens[0] ?? ""}`);
    }
    if (!hasUsernames) {
      nextLines.unshift(`TELEGRAM_BOT_USERNAMES=${normalizedUsernames.join(",")}`);
    }

    const output = `${nextLines.filter((line, index, all) => !(index === all.length - 1 && line === "")).join("\n")}\n`;
    await fs.writeFile(this.envPath, output, "utf8");
  }

  private normalizeUsernames(tokens: string[], usernames: string[]): string[] {
    return tokens.map((token, index) => usernames[index]?.trim() || `bot_${this.tokenId(token)}`);
  }

  private zipBots(tokens: string[], usernames: string[]): ManagedBot[] {
    const normalizedUsernames = this.normalizeUsernames(tokens, usernames);
    return tokens.map((token, index) => ({
      index,
      token,
      id: this.tokenId(token),
      username: normalizedUsernames[index]!,
    }));
  }

  private resolveBotSelector(bots: ManagedBot[], selector: string): ManagedBot | undefined {
    const normalized = selector.trim();
    const withoutAt = normalized.startsWith("@") ? normalized.slice(1) : normalized;
    return bots.find((bot) =>
      bot.username.toLowerCase() === withoutAt.toLowerCase()
      || String(bot.id) === withoutAt
      || bot.token === normalized,
    );
  }

  private async listConfiguredBots(): Promise<ManagedBot[]> {
    const env = await this.readEnvConfig();
    return this.zipBots(env.tokens, env.usernames);
  }

  private tokenId(token: string): number {
    return Number.parseInt(token.split(":", 1)[0] ?? "0", 10);
  }

  private parseCsv(value: string): string[] {
    return value
      .split(/[\r\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private async backupEnv(): Promise<string> {
    await fs.mkdir(this.backupsDir, { recursive: true });
    const backupPath = path.join(this.backupsDir, `telegram-bots-${Date.now()}.env.bak`);
    await fs.copyFile(this.envPath, backupPath);
    return backupPath;
  }

  private async restoreBackup(backupPath: string): Promise<void> {
    await fs.copyFile(backupPath, this.envPath);
  }

  private async writePendingOperation(operation: PendingBotOperation): Promise<void> {
    await fs.writeFile(this.pendingPath, JSON.stringify(operation, null, 2), "utf8");
  }

  private async readPendingOperation(): Promise<PendingBotOperation | undefined> {
    const raw = await fs.readFile(this.pendingPath, "utf8").catch(() => undefined);
    if (!raw?.trim()) {
      return undefined;
    }
    return JSON.parse(raw) as PendingBotOperation;
  }

  private async clearPendingOperation(): Promise<void> {
    await fs.rm(this.pendingPath, { force: true }).catch(() => undefined);
  }

  private async sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = JSON.stringify({
      chat_id: chatId,
      text,
    });

    const { stdout, stderr } = await execFileAsync("curl", [
      "-sS",
      "--max-time",
      "20",
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
      url,
    ]);

    if (stderr?.trim()) {
      console.error("curl stderr for sendMessage:", stderr.trim());
    }

    const parsed = JSON.parse(stdout) as { ok?: boolean; description?: string };
    if (!parsed.ok) {
      throw new Error(parsed.description || "sendMessage failed.");
    }
  }
}
