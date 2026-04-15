# RemoteAgent

Personal installable session server for continuing local AI work across PC and Telegram.

## Goal

RemoteAgent is for a single owner running their own AI work from their own work PC.

The target workflow is simple:

1. Start or resume a session on the work PC.
2. Continue that same session from Telegram while away from the desk.
3. Come back to the PC and keep going from the same session context.

This repository is not aiming at a hosted multi-user SaaS. It is a personal, installable runtime for one person's own accounts, own machine, and own workspaces.

## Product direction

RemoteAgent is moving from a Telegram bridge toward a personal session runtime:

- the work PC is the source of truth
- sessions are stored locally
- Telegram is a remote client for those sessions
- a future local PC chat UI will use the same session server
- providers such as Codex, Claude, and OpenClaw will sit behind a shared session model

Today the repository already supports:

- local PC chat UI at `http://127.0.0.1:3794` by default
- `/startpair codex [path]`
- `/startpair claude [path]`
- `/startpair both [path]`
- `/attach codex <thread_id> [path]`
- `/attach claude <session_id> [path]`
- `/sandbox codex <read-only|workspace-write|danger-full-access>`
- `/! <command>`
- `/!cmd <command>`
- `/!bash <command>`
- `/status`
- `/mode codex|claude|compare`
- `/reset`

The important capability is attach/resume:

- Codex chats can bind to an existing `thread_id`
- Claude chats can bind to an existing `session_id`
- each Telegram chat keeps its own provider, workspace, and session metadata

## Current commands

| Command | Purpose | Status |
| --- | --- | --- |
| `/startpair codex [path]` | Start a fresh Codex pairing for this Telegram chat | Supported |
| `/startpair claude [path]` | Start a fresh Claude pairing for this Telegram chat | Supported |
| `/startpair both [path]` | Pair Codex and Claude together for compare mode | Supported |
| `/attach codex <thread_id> [path]` | Attach this chat to an existing Codex session | Supported |
| `/attach claude <session_id> [path]` | Attach this chat to an existing Claude session | Supported |
| `/status` | Show current RemoteAgent session, workspace, provider session ids, and sandbox state | Supported |
| `/mode codex` | Route new messages to Codex only | Supported |
| `/mode claude` | Route new messages to Claude only | Supported |
| `/mode compare` | Route the same message to both providers | Supported |
| `/sandbox codex <read-only|workspace-write|danger-full-access>` | Change Codex sandbox mode for the current chat session | Supported |
| `/! <command>` | Run a native shell command in the current workspace | Supported with restrictions |
| `/!cmd <command>` | Run a `cmd.exe` command on Windows | Supported with restrictions |
| `/!bash <command>` | Run a `bash -lc` command | Supported with restrictions |
| `/reset` | Clear the current chat binding from the active RemoteAgent session | Supported |

## Provider support matrix

| Capability | Codex | Claude Code | OpenClaw |
| --- | --- | --- | --- |
| Fresh session from Telegram | Yes | Yes | Planned |
| Attach to existing session | Yes (`thread_id`) | Yes (`session_id`) | Planned |
| Resume same session across turns | Yes | Yes | Planned |
| Compare mode participation | Yes | Yes | Planned |
| Per-session sandbox control | Yes | No | Planned |
| `read-only` mode | Yes | N/A | Planned |
| `workspace-write` mode | Yes | N/A | Planned |
| `danger-full-access` mode | Yes | N/A | Planned |
| Restricted remote shell (`/!`) | Yes, when allowed | No | Planned |
| Current production adapter in this repo | Yes | Yes | No |
| Local PC chat UI integration | Planned | Planned | Planned |

Notes:

- Codex sandbox control is exposed through `/sandbox codex ...`.
- Remote shell commands are allowed only for the configured bot owner, only in private 1:1 chats, and only when the current Codex session sandbox is `danger-full-access`.
- Claude currently follows its adapter/runtime settings and does not have an equivalent Telegram sandbox command in this repo.
- OpenClaw is part of the planned architecture, but not implemented yet.

## Architecture

The high-level architecture is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
The first implementation scope is documented in [docs/MVP.md](docs/MVP.md).

In short:

```text
Telegram <-> RemoteAgent session server on work PC <-> provider adapters
                                              |-> Codex
                                              |-> Claude
                                              |-> OpenClaw (planned)
                                              |-> future local PC chat UI
```

## Scope

In scope:

- personal installation on a work PC
- single-owner usage
- local session persistence
- Telegram-based resume and control
- provider adapters with a shared session model

Out of scope for this repo direction:

- multi-tenant hosted service
- account resale or shared access
- pretending to mirror the internal state of official desktop apps exactly

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

Optional multi-bot:

- `TELEGRAM_BOT_TOKENS`

Useful:

- `DEFAULT_WORKSPACE`
- `TELEGRAM_OWNER_ID`
- `CODEX_BIN`
- `CODEX_SANDBOX_MODE`
- `CLAUDE_BIN`
- `CLAUDE_COMMAND`
- `CLAUDE_PERMISSION_MODE`
- `COMMAND_TIMEOUT_MS`
- `LOCAL_UI_ENABLED`
- `LOCAL_UI_HOST`
- `LOCAL_UI_PORT`

`TELEGRAM_BOT_TOKENS` may contain multiple bot tokens separated by commas or new lines. If it is set, RemoteAgent starts one Telegram bot per token and keeps them all attached to the same local session runtime. If it is not set, `TELEGRAM_BOT_TOKEN` is used as the single-bot fallback.

`CODEX_BIN` defaults to `codex`, and `CLAUDE_BIN` defaults to `claude`. `CODEX_SANDBOX_MODE` may be set to `read-only`, `workspace-write`, or `danger-full-access`. If you need custom wrappers instead, set `CODEX_COMMAND` or `CLAUDE_COMMAND`.

The local PC chat UI is enabled by default on `127.0.0.1:3794`. Set `LOCAL_UI_ENABLED=false` to disable it, or set `LOCAL_UI_HOST` and `LOCAL_UI_PORT` to change the bind address.

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

Then open Telegram and run one of these:

```text
/startpair codex C:\path\to\project
/attach codex <thread_id> C:\path\to\project
```

Open the local PC chat UI at:

```text
http://127.0.0.1:3794
```

## Development

```bash
npm install
npm run check
npm run build
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
