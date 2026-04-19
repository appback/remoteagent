import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { createBot } from "./bot.js";
import { ShellAdapter } from "./adapters/shell-adapter.js";
import { config } from "./config.js";
import { FileStore } from "./store/file-store.js";
import { BridgeService } from "./services/bridge-service.js";
import { LocalUiService } from "./services/local-ui-service.js";
import type { ProviderAdapter } from "./adapters/provider-adapter.js";
import type { Provider } from "./types.js";
import type { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const store = new FileStore(config.dataDir, config.defaultMode);
  await store.init();

  const adapters: Partial<Record<Provider, ProviderAdapter>> = {};
  if (config.commands.codex) {
    adapters.codex = new ShellAdapter("codex", config.commands.codex, config.commandTimeoutMs);
  } else {
    adapters.codex = new CodexAdapter(
      config.codexBin,
      config.commandTimeoutMs,
      config.codexSandboxMode,
    );
  }
  if (config.commands.claude) {
    adapters.claude = new ShellAdapter("claude", config.commands.claude, config.commandTimeoutMs);
  } else {
    adapters.claude = new ClaudeAdapter(
      config.claudeBin,
      config.commandTimeoutMs,
      config.claudePermissionMode,
    );
  }

  const bridge = new BridgeService(store, adapters, config.defaultWorkspace);
  if (config.localUiEnabled) {
    const localUi = new LocalUiService(bridge, config.localUiHost, config.localUiPort);
    await localUi.start()
      .then(() => {
        console.log(`Local UI is ready at http://${config.localUiHost}:${config.localUiPort}`);
      })
      .catch((error) => {
        console.error("Local UI failed to start:", error);
      });
  }

  const botInfos = config.telegramBotTokens.map((token, index) => buildBotInfo(token, index));
  const bots = config.telegramBotTokens.map((token, index) => createBot(token, bridge, botInfos[index]!));

  for (const bot of bots) {
    const username = bot.botInfo.username;
    console.log(`Bot @${username} is ready`);
  }

  await Promise.all(bots.map((bot) => startManualPolling(bot)));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function startManualPolling(bot: Bot): Promise<never> {
  const pollingBot = bot as unknown as {
    token: string;
    handleUpdates(updates: unknown[]): Promise<void>;
    botInfo: { username?: string };
  };
  let offset = 0;

  while (true) {
    try {
      const payload = await getUpdatesViaCurl(pollingBot.token, offset);

      if (payload.result.length === 0) {
        continue;
      }

      await pollingBot.handleUpdates(payload.result);
      offset = payload.result[payload.result.length - 1]!.update_id + 1;
    } catch (error) {
      console.error(`Polling failed for @${pollingBot.botInfo.username}:`, error);
      await sleep(2000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getUpdatesViaCurl(token: string, offset: number): Promise<{
  ok?: boolean;
  result: Array<{ update_id: number }>;
  description?: string;
}> {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  url.searchParams.set("timeout", "30");
  url.searchParams.set("limit", "50");
  if (offset > 0) {
    url.searchParams.set("offset", String(offset));
  }

  const { stdout, stderr } = await execFileAsync("curl", [
    "-sS",
    "--max-time",
    "35",
    url.toString(),
  ]);

  if (stderr?.trim()) {
    console.error(`curl stderr for getUpdates: ${stderr.trim()}`);
  }

  const payload = JSON.parse(stdout) as {
    ok?: boolean;
    result?: Array<{ update_id: number }>;
    description?: string;
  };

  if (!payload.ok || !Array.isArray(payload.result)) {
    throw new Error(payload.description || "getUpdates returned an invalid payload.");
  }

  return {
    ok: payload.ok,
    result: payload.result,
    description: payload.description,
  };
}

function buildBotInfo(token: string, index: number): UserFromGetMe {
  const id = Number.parseInt(token.split(":", 1)[0] ?? "", 10);
  const configuredUsername = config.telegramBotUsernames[index];
  const fallbackUsername = knownBotUsername(id);
  const username = configuredUsername || fallbackUsername || `bot_${Number.isFinite(id) ? id : index + 1}`;

  return {
    id: Number.isFinite(id) ? id : index + 1,
    is_bot: true,
    first_name: username,
    username,
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as UserFromGetMe;
}

function knownBotUsername(id: number): string | undefined {
  if (id === 8369496408) {
    return "codex_remoteagent_bot";
  }
  if (id === 8429712341) {
    return "sqream_bot";
  }
  return undefined;
}
