import { createBot } from "./bot.js";
import { ShellAdapter } from "./adapters/shell-adapter.js";
import { config } from "./config.js";
import { FileStore } from "./store/file-store.js";
import { BridgeService } from "./services/bridge-service.js";
import type { Provider } from "./types.js";

async function main(): Promise<void> {
  const store = new FileStore(config.dataDir, config.defaultMode);
  await store.init();

  const adapters: Partial<Record<Provider, ShellAdapter>> = {};
  if (config.commands.codex) {
    adapters.codex = new ShellAdapter("codex", config.commands.codex, config.commandTimeoutMs);
  }
  if (config.commands.claude) {
    adapters.claude = new ShellAdapter("claude", config.commands.claude, config.commandTimeoutMs);
  }

  const bridge = new BridgeService(store, adapters);
  const bot = createBot(config.telegramBotToken, bridge);

  await bot.init();
  const username = bot.botInfo.username;
  console.log(`Bot @${username} is ready`);
  await bot.start();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
