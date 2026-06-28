# RemoteAgent

RemoteAgent is a personal installable runtime for controlling coding sessions from Telegram, a terminal, and an optional Telegram Mini App.

It is built for one owner running their own agents on their own machine, then continuing that work remotely without introducing a hosted multi-user backend.

## What it is

RemoteAgent is not a hosted SaaS and not a Telegram-only app.

It has three layers:

1. **Runtime server** - the installed machine that actually runs Codex, Claude Code, shell commands, and file operations.
2. **Telegram bot** - the default remote messaging interface.
3. **Telegram Mini App** - an optional richer UI that opens inside Telegram and controls the same runtime.

The runtime machine is the source of truth. Telegram is the client.

## What it does

RemoteAgent is currently organized around six core capabilities.

| Capability | What it means today | Status |
| --- | --- | --- |
| Telegram control | Telegram chat can start, attach, switch, inspect, and reset local sessions | Supported |
| Terminal control | The owner can run restricted remote shell commands from Telegram | Supported with restrictions |
| Telegram <-> Codex | A Telegram chat can start or attach to a Codex session and continue it | Supported |
| Telegram <-> Claude Code | A Telegram chat can start or attach to a Claude Code session and continue it | Supported |
| Telegram attachments | Telegram can send images, text, Markdown, PDF, Word documents, spreadsheet files, archives, and audio/voice inputs into the runtime | Supported |
| Telegram Mini App UI | A richer Telegram-native UI can sit on top of the same runtime and session model | Planned next |

## Product direction

RemoteAgent is a self-hosted personal runtime, not a hosted SaaS.

The intended shape is:

1. the machine running RemoteAgent is the source of truth
2. Telegram chat is the baseline remote client for that runtime
3. a Telegram Mini App is an optional UI layer over the same runtime
4. Codex and Claude Code are provider adapters behind one local session model
5. terminal control is an owner-only extension of that same runtime
6. files sent from Telegram are materialized locally and then routed through the active session

This repository is optimized for continuity:

- start work on the machine
- continue from Telegram
- optionally open a Mini App for richer session controls
- come back and keep going from the same runtime-owned session state

## Why a Mini App fits

A Telegram Mini App does **not** replace the runtime server.
It gives RemoteAgent a better control surface inside Telegram.

That means a Mini App can expose:

- session list and switching
- current provider and model
- recent logs and progress states
- stop and continue actions
- attachment history
- safer structured controls than raw slash commands

But the Mini App still depends on the installed RemoteAgent runtime and the local provider CLIs.

## Current scope

In scope:

- one owner
- one installable local runtime
- local session persistence
- Telegram control
- Codex and Claude Code adapters
- restricted terminal control
- Telegram attachment intake
- future Telegram Mini App control UI for the same runtime

Out of scope:

- multi-tenant hosted backend
- account resale
- team-facing SaaS control plane
- pretending to mirror official desktop apps exactly
- making Telegram the actual execution backend

## Current capabilities

### 1. Telegram control

Telegram is the main remote control surface today.

Current command surface implemented in `src/bot.ts`:

| Command | What it does |
| --- | --- |
| `/start [codex|claude]` | Starts a fresh fixed-mode session in a new managed workspace under `WORKSPACE_ROOT` |
| `/help` | Shows the current command list |
| `/list` | Lists recent sessions |
| `/list -a` | Lists all sessions with active/unused status, managed workspace size, and last update time |
| `/new` | Creates and binds a new session using the saved default mode in a new managed workspace |
| `/switch <session>` | Rebinds this chat to an existing RemoteAgent session |
| `/status` | Shows current session, workspace, provider, and sandbox state |
| `/option retry <count>` | Sets the automatic continuation turn limit and persists it to `~/.remoteagent/.env` |
| `/option timeout <seconds>` | Sets the provider execution timeout and persists it to `~/.remoteagent/.env` |
| `/option intent <count>` | Sets retries for untagged intent-only provider replies and persists it to `~/.remoteagent/.env` |
| `/state` | Shows the session ledger that is injected as provider context |
| `/state clear` | Clears the current session ledger without deleting the session |
| `/state note <text>` | Adds an operator note to the session ledger |
| `/bots` | Lists the currently configured Telegram bots |
| `/bot add <token>` | Adds a conversation bot, restarts the runtime, and confirms the result after restart |
| `/bot doctor` | Checks configured Telegram bots and removes bots that Telegram reports as permanently dead |
| `/bot remove <username\|id>` | Removes a configured Telegram bot, restarts the runtime, and confirms the result after restart |
| `/bot reload` | Restarts the runtime and confirms the result after restart |
| `/install codex\|claude` | Runs the configured provider install or update command for the bot owner |
| `/login codex` | Starts the Codex device-auth login flow and returns a browser URL when available |
| `/login claude [token]` | Starts or finishes the configured Claude Code login flow for the bot owner |
| `/reset` | Clears the current chat binding |
| `/batch start` | Starts manual batching of multiple text messages |
| `/batch send` | Sends the collected batch |
| `/batch done` | Alias for `/batch send` |
| `/batch cancel` | Discards the current batch |
| `/batch status` | Shows current batch state |

Multi-bot polling is tiered by recent activity and active provider work. See [docs/BOT_POLLING_POLICY.md](./docs/BOT_POLLING_POLICY.md).

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

- `/start codex`
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

- `/start claude`
- `/attach claude <session_id>`

Current Claude behavior:

- fresh pairing from Telegram
- attach to existing `session_id`
- continue the same Claude Code session across turns
- optional owner-only install/login flow through `/install claude` and `/login claude [token]`

### 5. Telegram attachments

Telegram attachments are written into the local runtime under `~/.remoteagent/uploads/telegram/<bot>/<chat>/...` and then routed through the active session. Artifact metadata is indexed at `~/.remoteagent/managed/artifacts.json`.

Attachments can be inspected with `/artifacts list` and cleaned manually with `/artifacts cleanup <days>`. RemoteAgent also runs periodic artifact cleanup when `ARTIFACT_CLEANUP_ENABLED=true`; by default it keeps 30 days and also removes old unindexed files under `uploads/telegram`.

Current supported attachment classes:

- photos
- image files
- text files
- Markdown files
- PDF documents
- Word documents (.docx, basic .doc intake)
- spreadsheet files (.xlsx, .xlsm, basic .xls intake)
- archive files
- voice messages
- audio files

Attachment handling is triggered from ordinary Telegram messages.
If the message contains a supported file or media payload, RemoteAgent downloads it, stores it locally, builds an attachment prompt, and sends that into the active provider session.

### 6. Telegram Mini App

The Mini App is the next UI layer, not a second execution engine.

The Mini App should talk to the same runtime state used by the bot, including:

- session ids
- session bindings
- provider metadata
- event logs
- attachment history
- stop and continue controls

See [docs/MINI_APP.md](docs/MINI_APP.md) for the planned Mini App shape.

## Provider support matrix

| Capability | Codex | Claude Code | OpenClaw |
| --- | --- | --- | --- |
| Fresh Telegram pairing | Yes | Yes | Planned |
| Attach to existing session | Yes | Yes | Planned |
| Resume same session across turns | Yes | Yes | Planned |
| Telegram-based remote shell participation | Yes | No | Planned |
| Per-session sandbox control from Telegram | Yes | No | Planned |
| Attachment routing through active session | Yes | Yes | Planned |
| Telegram Mini App control surface | Planned | Planned | Planned |
| Production adapter in this repo | Yes | Yes | No |

## Release policy

Every production deployment must bump the package version using semantic versioning.

- `MAJOR`: breaking changes or migration-required runtime changes
- `MINOR`: new capabilities or non-breaking feature expansion
- `PATCH`: bug fixes, hardening, and maintenance updates

A change is not considered finished until it is committed and pushed.
A deployment on server 30 is not considered complete until machine 21's npm-installed runtime is updated as well.

See [docs/RELEASING.md](docs/RELEASING.md) for the release checklist and version bump commands.
See [docs/ERROR_NORMALIZATION.md](docs/ERROR_NORMALIZATION.md) for provider error classification and retry behavior.

## Runtime layout

Installed runtime data lives in:

- Linux/macOS: `~/.remoteagent`
- Windows: `%USERPROFILE%\.remoteagent`

Typical directories and files include:

Managed workspaces created by `/start` without an explicit path live under `WORKSPACE_ROOT` and use random 8-character uid folder names, while public session ids like `S001` remain display-only ids.

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
- `WORKSPACE_ROOT`
- `COMMAND_TIMEOUT_MS`
- `SETUP_COMMAND_TIMEOUT_MS`
- `ARTIFACT_CLEANUP_ENABLED`
- `ARTIFACT_RETENTION_DAYS`
- `ARTIFACT_CLEANUP_INTERVAL_MS`
- `CODEX_BIN`
- `CODEX_SANDBOX_MODE`
- `CODEX_INSTALL_COMMAND`
- `CLAUDE_BIN`
- `CLAUDE_COMMAND`
- `CLAUDE_PERMISSION_MODE`
- `CLAUDE_INSTALL_COMMAND`
- `CLAUDE_LOGIN_START_COMMAND`
- `CLAUDE_LOGIN_FINISH_COMMAND`
- `REMOTEAGENT_SERVICE_NAME`
- `BOT_RESTART_HELPER_PATH`
- `LOCAL_UI_ENABLED`
- `LOCAL_UI_HOST`
- `LOCAL_UI_PORT`

## Quick start

### Linux / macOS

```bash
npm install -g appback-remoteagent
remoteagent-install
remoteagent-start
```

`remoteagent-install` seeds provider install/login hook paths into `~/.remoteagent/.env` automatically, so `/install codex` and `/install claude` work on a fresh machine without manual hook wiring.

For one-line installs on a fresh machine:

```bash
curl -fsSL https://raw.githubusercontent.com/appback/remoteagent/main/scripts/install.sh | bash
remoteagent-start
```

The piped installer installs `appback-remoteagent` from npm. It does not deploy a Git checkout as the runtime.

### Windows PowerShell

Native Windows service packaging is not finalized yet. For now, use WSL/Linux for production runtimes, or run the repository-local PowerShell scripts during development:

```powershell
.\scripts\install.ps1
.\scripts\start.ps1
```

The installer also writes default provider install/login hook paths into `%USERPROFILE%\.remoteagent\.env`.

After `/install codex` or `/install claude`, RemoteAgent now also checks whether the provider still needs authentication and tells the operator the next login step.

Then open Telegram and start with one of these common flows. `/start` without a mode uses the saved default mode once a provider has been started or attached at least once.

```text
/start
/start codex
/start claude
/install codex
/install claude
/login codex
/login claude
/login claude <token>
/attach codex <thread_id>
/attach claude <session_id>
```

Once a chat is bound, ordinary text messages continue the active session. Supported attachments can also be sent directly as normal Telegram messages.

## Architecture and operations

High-level architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Mini App plan: [docs/MINI_APP.md](docs/MINI_APP.md)

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
