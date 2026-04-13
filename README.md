# RemoteAgent

Telegram bot for pairing each Telegram chat with one Codex session, one Claude session, or both.

## What it does

- `/startpair codex` creates or reconnects a Codex session for the current Telegram chat
- `/startpair claude` creates or reconnects a Claude session for the current Telegram chat
- `/startpair both` prepares both sessions so `/mode compare` can fan out to both tools
- `/status` shows the active pair and routing mode
- `/mode codex|claude|compare` changes where incoming chat messages are routed
- `/reset` clears the current chat mapping

## How session matching works

Each Telegram chat gets a persistent local bridge record:

- `chatId`
- `mode`
- `codex.sessionId` if paired
- `claude.sessionId` if paired

The bridge keeps those IDs in `.data/state.json`. The actual conversation history is expected to live inside the target tool, keyed by the session ID you pass through the adapter command.

## Adapter model

This project does not hardcode Codex or Claude Code transport APIs. Instead, it runs shell commands that you configure through environment variables:

- `CODEX_COMMAND`
- `CLAUDE_COMMAND`

When the bot forwards a message, it invokes the configured command with these environment variables:

- `BRIDGE_MESSAGE`
- `BRIDGE_SESSION_ID`
- `BRIDGE_CHAT_ID`
- `BRIDGE_PROVIDER`

The command should print the final assistant response to `stdout`.

### Example wrapper script

Create a wrapper script that reads those variables and calls your actual CLI:

```bash
#!/usr/bin/env bash
set -euo pipefail

codex exec \
  --session "$BRIDGE_SESSION_ID" \
  --input "$BRIDGE_MESSAGE"
```

Then set:

```bash
CODEX_COMMAND="bash scripts/codex.sh"
CLAUDE_COMMAND="bash scripts/claude.sh"
```

## Setup

```bash
npm install
cp .env.example .env
```

Fill in:

- `TELEGRAM_BOT_TOKEN`
- `CODEX_COMMAND`
- `CLAUDE_COMMAND`

For a quick smoke test without wiring the real tools yet:

```bash
chmod +x scripts/mock-adapter.sh
CODEX_COMMAND="bash scripts/mock-adapter.sh"
CLAUDE_COMMAND="bash scripts/mock-adapter.sh"
```

## Run

```bash
npm run dev
```

## Notes

- `compare` mode requires both providers to be paired and configured
- responses are appended to `.data/logs/<chatId>.jsonl`
- for a first MVP, the store is file-based so it is easy to inspect and replace later
