import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
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
  mainBotId?: string;
};

type BotCommandResult = {
  message: string;
};

type PendingBotOperationNotice = {
  message: string;
  pending: boolean;
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
    const env = await this.readEnvConfig();
    const bots = this.zipBots(env.tokens, env.usernames);
    if (bots.length === 0) {
      return "No Telegram bots are configured.";
    }

    return this.formatBots(bots, env.mainBotId);
  }

  async getPendingOperationNotice(): Promise<PendingBotOperationNotice | undefined> {
    const pending = await this.readPendingOperation();
    if (!pending) {
      return undefined;
    }

    return {
      pending: pending.status === "pending",
      message: this.formatPendingOperationMessage(pending),
    };
  }

  async addBot(token: string, sourceBotId: string, sourceBotToken: string, chatId: number): Promise<BotCommandResult> {
    await this.ensureSupported();
    await this.assertNoPendingOperation();

    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Usage: /bot add <token>");
    }

    const target = await this.fetchBotIdentity(trimmed);
    const env = await this.readEnvConfig();
    const bots = this.zipBots(env.tokens, env.usernames);
    const existing = bots.find((bot) =>
      bot.token === trimmed
      || bot.id === target.id
      || bot.username.toLowerCase() === target.username.toLowerCase(),
    );

    if (existing) {
      throw new Error(`@${target.username} is already configured.`);
    }

    const tokens = [...env.tokens, trimmed];
    const usernames = [...env.usernames, target.username];
    const mainBotId = this.resolveMainBotId(this.zipBots(tokens, usernames), env.mainBotId);
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
      await this.writeEnvConfig(env.lines, tokens, usernames, mainBotId);
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
    await this.assertNoPendingOperation();

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
    const currentMain = this.resolveMainBot(bots, env.mainBotId);
    const nextMainBotId = currentMain?.token === target.token
      ? this.promoteMainBotAfterRemoval(bots, target)?.id.toString()
      : this.resolveMainBotId(remainingBots, env.mainBotId);
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
      await this.writeEnvConfig(env.lines, tokens, usernames, nextMainBotId);
      await this.launchRestartJob();
    } catch (error) {
      await this.restoreBackup(backupEnvPath).catch(() => undefined);
      await this.clearPendingOperation().catch(() => undefined);
      throw error;
    }

    const promoted = nextMainBotId ? remainingBots.find((bot) => String(bot.id) === nextMainBotId) : undefined;
    const mainLine = promoted && currentMain?.token === target.token
      ? `Main bot will be promoted to @${promoted.username} (${promoted.id}).`
      : undefined;
    const notifyLine = replyToken === sourceBotToken || !notifyViaUsername
      ? "The runtime will restart once and then report the result here."
      : `The runtime will restart once and then report the result through @${notifyViaUsername}.`;

    return {
      message: [
        `Applying bot removal for @${target.username} (${target.id}).`,
        mainLine,
        notifyLine,
      ].filter(Boolean).join("\n\n"),
    };
  }

  async setMainBot(selector: string): Promise<BotCommandResult> {
    await this.ensureSupported();
    await this.assertNoPendingOperation();

    const trimmed = selector.trim();
    if (!trimmed) {
      throw new Error("Usage: /bot main <number|@username|id>");
    }

    const env = await this.readEnvConfig();
    const bots = this.zipBots(env.tokens, env.usernames);
    const target = this.resolveBotSelector(bots, trimmed);
    if (!target) {
      throw new Error(`Bot was not found: ${trimmed}`);
    }

    await this.writeEnvConfig(env.lines, env.tokens, env.usernames, String(target.id));
    return {
      message: [
        `Set main bot to @${target.username} (${target.id}).`,
        "",
        this.formatBots(bots, String(target.id)),
      ].join("\n"),
    };
  }

  async reloadBots(sourceBotId: string, sourceBotToken: string, chatId: number): Promise<BotCommandResult> {
    await this.ensureSupported();
    await this.assertNoPendingOperation();
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

    const env = await this.readEnvConfig().catch(() => undefined);
    const bots = env ? this.zipBots(env.tokens, env.usernames) : [];
    const mainBotId = this.resolveMainBotId(bots, env?.mainBotId);
    const listLines = bots.length > 0
      ? this.formatBotListLines(bots, mainBotId).map((line) => `- ${line.replace(/^\d+\.\s*/, "")}`)
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

  private async assertNoPendingOperation(): Promise<void> {
    const pending = await this.readPendingOperation();
    if (!pending || pending.status !== "pending") {
      return;
    }

    throw new Error(this.formatPendingOperationMessage(pending));
  }

  private formatPendingOperationMessage(pending: PendingBotOperation): string {
    const actionLine = `Action: ${pending.action}`;
    const targetLine = pending.target
      ? `Target: @${pending.target.username} (${pending.target.id})`
      : undefined;

    if (pending.status === "rolled_back") {
      return [
        "The last bot configuration change failed and was rolled back.",
        actionLine,
        targetLine,
        pending.reason ? `Reason: ${pending.reason}` : undefined,
      ].filter(Boolean).join("\n");
    }

    return [
      "A bot configuration change is still being applied.",
      actionLine,
      targetLine,
      "Wait for the \"Bot configuration applied successfully.\" message, then try again.",
    ].filter(Boolean).join("\n");
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
    const unitName = `remoteagent-bot-op-${Date.now()}`;
    try {
      const { stderr } = await execFileAsync("sudo", [
        "-n",
        "systemd-run",
        "--unit",
        unitName,
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
      return;
    } catch (error) {
      if (!this.shouldFallbackToUserRestart(error)) {
        throw error;
      }
    }

    const child = spawn(this.restartHelperPath, [this.serviceName, this.dataDir], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  private shouldFallbackToUserRestart(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /sudo: a password is required/i.test(message)
      || /command not found/i.test(message)
      || /systemd-run/i.test(message);
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
    const mainBotLine = lines.find((line) => line.startsWith("TELEGRAM_MAIN_BOT_ID="));

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
      mainBotId: mainBotLine?.slice("TELEGRAM_MAIN_BOT_ID=".length).trim() || undefined,
    };
  }

  private async writeEnvConfig(originalLines: string[], tokens: string[], usernames: string[], mainBotId?: string): Promise<void> {
    const normalizedUsernames = this.normalizeUsernames(tokens, usernames);
    const normalizedMainBotId = this.resolveMainBotId(this.zipBots(tokens, normalizedUsernames), mainBotId);
    const nextLines: string[] = [];
    let hasMulti = false;
    let hasSingle = false;
    let hasUsernames = false;
    let hasMainBot = false;

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
      if (line.startsWith("TELEGRAM_MAIN_BOT_ID=")) {
        if (normalizedMainBotId) {
          nextLines.push(`TELEGRAM_MAIN_BOT_ID=${normalizedMainBotId}`);
        }
        hasMainBot = true;
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
    if (!hasMainBot && normalizedMainBotId) {
      nextLines.unshift(`TELEGRAM_MAIN_BOT_ID=${normalizedMainBotId}`);
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
    if (/^\d+$/.test(normalized)) {
      const index = Number.parseInt(normalized, 10);
      if (index >= 1 && index <= bots.length) {
        return bots[index - 1];
      }
    }
    const withoutAt = normalized.startsWith("@") ? normalized.slice(1) : normalized;
    return bots.find((bot) =>
      bot.username.toLowerCase() === withoutAt.toLowerCase()
      || String(bot.id) === withoutAt
      || bot.token === normalized,
    );
  }

  private formatBots(bots: ManagedBot[], mainBotId?: string): string {
    if (bots.length === 0) {
      return "No Telegram bots are configured.";
    }

    return [
      `Configured bots (${bots.length})`,
      ...this.formatBotListLines(bots, mainBotId),
    ].join("\n");
  }

  private formatBotListLines(bots: ManagedBot[], explicitMainBotId?: string): string[] {
    const mainBotId = this.resolveMainBotId(bots, explicitMainBotId);
    return bots.map((bot, index) => {
      const suffix = String(bot.id) === mainBotId ? " [main]" : "";
      return `${index + 1}. @${bot.username} (${bot.id})${suffix}`;
    });
  }

  private resolveMainBot(bots: ManagedBot[], mainBotId?: string): ManagedBot | undefined {
    if (bots.length === 0) {
      return undefined;
    }

    const explicit = mainBotId ? bots.find((bot) => String(bot.id) === mainBotId) : undefined;
    return explicit ?? bots[0];
  }

  private resolveMainBotId(bots: ManagedBot[], mainBotId?: string): string | undefined {
    return this.resolveMainBot(bots, mainBotId)?.id.toString();
  }

  private promoteMainBotAfterRemoval(bots: ManagedBot[], removed: ManagedBot): ManagedBot | undefined {
    const remaining = bots.filter((bot) => bot.token !== removed.token);
    return remaining[removed.index] ?? remaining[0];
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
