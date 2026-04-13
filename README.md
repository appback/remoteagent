# RemoteAgent

Installable Telegram bridge for local Codex and Claude sessions.

## What changed

This build now stores real local session metadata per Telegram chat:

- `chatId`
- `provider`
- `cwd`
- `sessionId`

For Codex, the first message creates a real local thread with `codex exec`, captures the returned `thread_id`, and saves it. The next message uses `codex exec resume <thread_id>` so the Telegram chat keeps talking to the same Codex conversation.

## Commands

- `/startpair codex [path]`
- `/startpair claude [path]`
- `/startpair both [path]`
- `/status`
- `/mode codex|claude|compare`
- `/reset`

If `path` is omitted, RemoteAgent reuses the previously paired workspace for that chat. If the chat has no workspace yet, it falls back to `DEFAULT_WORKSPACE`, then to the current user's home directory.

## Installable layout

Installed runtime data lives in:

- Linux/macOS: `~/.remoteagent`
- Windows: `%USERPROFILE%\\.remoteagent`

The app loads configuration from:

1. repo root `.env`
2. installed config `~/.remoteagent/.env` or `%USERPROFILE%\\.remoteagent\\.env`

Installed state lives in `state.json` under that same directory.

## Environment

Required:

- `TELEGRAM_BOT_TOKEN`

Useful:

- `DEFAULT_WORKSPACE`
- `CODEX_BIN`
- `CLAUDE_BIN`
- `CLAUDE_COMMAND`
- `CLAUDE_PERMISSION_MODE`
- `COMMAND_TIMEOUT_MS`

`CODEX_BIN` defaults to `codex`, and `CLAUDE_BIN` defaults to `claude`. If you need custom wrappers instead, set `CODEX_COMMAND` or `CLAUDE_COMMAND` and they will override the built-in adapters.

## Quick start

### Linux / macOS

```bash
./scripts/install.sh
./scripts/start.sh
```

### Windows PowerShell

```powershell
.\scripts\install.ps1
.\scripts\start.ps1
```

On Windows, keep the repository on a normal Windows path such as `C:\projects\remoteagent`. Do not run the PowerShell installer from a `\\wsl.localhost\...` path.

Then open Telegram and run:

```text
/startpair codex /absolute/path/to/your/project
```

After that, normal chat messages continue the same Codex thread for that Telegram chat.

## Claude integration

Claude now has a built-in adapter too:

- first turn: `claude --print --session-id <uuid>`
- follow-up turns: `claude --print --resume <session-id>`

The working directory must stay the same for resume to succeed, so RemoteAgent stores `cwd` beside the Claude session ID just like Codex.

If you prefer a custom wrapper, `CLAUDE_COMMAND` still wins over the built-in adapter. A wrapper receives:

- `BRIDGE_MESSAGE`
- `BRIDGE_SESSION_ID`
- `BRIDGE_CHAT_ID`
- `BRIDGE_PROVIDER`
- `BRIDGE_CWD`

## Development

```bash
npm install
npm run check
npm run build
```

For a smoke test without real providers:

```bash
chmod +x scripts/mock-adapter.sh
CODEX_COMMAND="bash scripts/mock-adapter.sh" CLAUDE_COMMAND="bash scripts/mock-adapter.sh" npm run dev
```
