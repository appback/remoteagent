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

  const bots = config.telegramBotTokens.map((token) => createBot(token, bridge));

  for (const bot of bots) {
    await bot.init();
    const username = bot.botInfo.username;
    console.log(`Bot @${username} is ready`);
  }

  await Promise.all(bots.map((bot) => bot.start()));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
