# RemoteAgent

RemoteAgent is a personal installable runtime for controlling coding sessions from Telegram and the terminal.

It is built for one owner running their own agents on their own machine, then continuing that work remotely without introducing a hosted multi-user backend.

## What it does

RemoteAgent is currently organized around five core capabilities.

| Capability | What it means today | Status |
| --- | --- | --- |
| Telegram control | Telegram chat can start, attach, switch, inspect, and reset local sessions | Supported |
| Terminal control | The owner can run restricted remote shell commands from Telegram | Supported with restrictions |
| Telegram <-> Codex | A Telegram chat can start or attach to a Codex session and continue it | Supported |
| Telegram <-> Claude Code | A Telegram chat can start or attach to a Claude Code session and continue it | Supported |
| Telegram attachments | Telegram can send images, text, Markdown, PDF, archives, and audio/voice inputs into the runtime | Supported |

## Product direction

RemoteAgent is an installable personal runtime, not a hosted SaaS.

The intended shape is:

1. the machine running RemoteAgent is the source of truth
2. Telegram is a remote client for that runtime
3. Codex and Claude Code are provider adapters behind one local session model
4. terminal control is an owner-only extension of that same runtime
5. files sent from Telegram are materialized locally and then routed through the active session

This repository is optimized for continuity:

- start work on the machine
- continue from Telegram
- come back and keep going from the same runtime-owned session state

## Current scope

In scope:

- one owner
- one installable local runtime
- local session persistence
- Telegram control
- Codex and Claude Code adapters
- restricted terminal control
- Telegram attachment intake

Out of scope:

- multi-tenant hosted backend
- account resale
- team-facing SaaS control plane
- pretending to mirror official desktop apps exactly

## Current capabilities

### 1. Telegram control

Telegram is the main remote control surface today.

Current command surface implemented in `src/bot.ts`:

| Command | What it does |
| --- | --- |
| `/start [codex|claude] [path]` | Starts a fresh fixed-mode session; without a mode it starts the saved default mode |
| `/help` | Shows the current command list |
| `/list` | Lists recent sessions |
| `/new [path]` | Creates and binds a new session using the saved default mode |
| `/switch <session>` | Rebinds this chat to an existing RemoteAgent session |
| `/status` | Shows current session, workspace, provider, and sandbox state |
| `/install codex\|claude` | Runs the configured provider install command for the bot owner |
| `/login claude [token]` | Starts or finishes the configured Claude Code login flow for the bot owner |
| `/reset` | Clears the current chat binding |
| `/batch start` | Starts manual batching of multiple text messages |
| `/batch send` | Sends the collected batch |
| `/batch done` | Alias for `/batch send` |
| `/batch cancel` | Discards the current batch |
| `/batch status` | Shows current batch state |

### 2. Terminal control

Remote shell control is available through:

- `/! <command>`
- `/!cmd <command>`
- `/!bash <command>`

This is intentionally restricted.

Remote shell requires all of the following:

- private 1:1 Telegram chat
- sender matches `TELEGRAM_OWNER_ID`
- active Codex binding exists
- current Codex sandbox is `danger-full-access`

### 3. Telegram and Codex

RemoteAgent supports both fresh Codex pairing and attach/resume.

Current Codex entry commands:

- `/start codex [path]`
- `/attach codex <thread_id>`
- `/sandbox codex <read-only|workspace-write|danger-full-access>`

Current Codex behavior:

- fresh pairing from Telegram
- attach to existing `thread_id`
- continue the same Codex session across turns
- per-session sandbox selection

### 4. Telegram and Claude Code

RemoteAgent also supports fresh Claude Code pairing and attach/resume.

Current Claude entry commands:

- `/start claude [path]`
- `/attach claude <session_id>`

Current Claude behavior:

- fresh pairing from Telegram
- attach to existing `session_id`
- continue the same Claude Code session across turns
- optional owner-only install/login flow through `/install claude` and `/login claude [token]`

### 5. Telegram attachments

Telegram attachments are written into the local runtime under `~/.remoteagent/uploads/telegram/...` and then routed through the active session.

Current supported attachment classes:

- photos
- image files
- text files
- Markdown files
- PDF documents
- archive files
- voice messages
- audio files

Attachment handling is triggered from ordinary Telegram messages.
If the message contains a supported file or media payload, RemoteAgent downloads it, stores it locally, builds an attachment prompt, and sends that into the active provider session.

The transport/runtime layer for attachments is implemented. User-facing attachment response policy is still being improved.

## Provider support matrix

| Capability | Codex | Claude Code | OpenClaw |
| --- | --- | --- | --- |
| Fresh Telegram pairing | Yes | Yes | Planned |
| Attach to existing session | Yes | Yes | Planned |
| Resume same session across turns | Yes | Yes | Planned |
| Telegram-based remote shell participation | Yes | No | Planned |
| Per-session sandbox control from Telegram | Yes | No | Planned |
| Attachment routing through active session | Yes | Yes | Planned |
| Production adapter in this repo | Yes | Yes | No |

## Runtime layout

Installed runtime data lives in:

- Linux/macOS: `~/.remoteagent`
- Windows: `%USERPROFILE%\.remoteagent`

Typical directories and files include:

- `.env`
- `logs/`
- `uploads/telegram/`
- `sessions/`
- `channels/telegram/`
- `state.json`

## Environment

Useful runtime variables:

Provider install/login hooks are optional and are executed only from owner-only Telegram commands.

Recommended Linux hooks in this repo:

- `scripts/install-codex.sh`
- `scripts/install-claude.sh`
- `scripts/start-claude-login.sh`
- `scripts/finish-claude-login.sh`

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_TOKENS`
- `TELEGRAM_OWNER_ID`
- `DEFAULT_WORKSPACE`
- `COMMAND_TIMEOUT_MS`
- `SETUP_COMMAND_TIMEOUT_MS`
- `CODEX_BIN`
- `CODEX_SANDBOX_MODE`
- `CODEX_INSTALL_COMMAND`
- `CLAUDE_BIN`
- `CLAUDE_COMMAND`
- `CLAUDE_PERMISSION_MODE`
- `CLAUDE_INSTALL_COMMAND`
- `CLAUDE_LOGIN_START_COMMAND`
- `CLAUDE_LOGIN_FINISH_COMMAND`
- `LOCAL_UI_ENABLED`
- `LOCAL_UI_HOST`
- `LOCAL_UI_PORT`

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

Then open Telegram and start with one of these common flows. `/start` without a mode uses the saved default mode once a provider has been started or attached at least once.

```text
/start
/start codex /path/to/project
/start claude /path/to/project
/install codex
/install claude
/login claude
/login claude <token>
/attach codex <thread_id>
/attach claude <session_id>
```

Once a chat is bound, ordinary text messages continue the active session. Supported attachments can also be sent directly as normal Telegram messages.

## Architecture and operations

High-level architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

MVP scope: [docs/MVP.md](docs/MVP.md)

Operational ownership and deployment rules: [docs/OPERATIONS.md](docs/OPERATIONS.md)

Reference notes about `cokacdir`: [docs/COKACDIR_NOTES.md](docs/COKACDIR_NOTES.md)

## Development

```bash
npm install
npm run check
npm run build
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
