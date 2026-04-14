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

- `/startpair codex [path]`
- `/startpair claude [path]`
- `/startpair both [path]`
- `/attach codex <thread_id> [path]`
- `/attach claude <session_id> [path]`
- `/sandbox codex <read-only|workspace-write|danger-full-access>`
- `/status`
- `/mode codex|claude|compare`
- `/reset`

The important capability is attach/resume:

- Codex chats can bind to an existing `thread_id`
- Claude chats can bind to an existing `session_id`
- each Telegram chat keeps its own provider, workspace, and session metadata

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

Useful:

- `DEFAULT_WORKSPACE`
- `CODEX_BIN`
- `CODEX_SANDBOX_MODE`
- `CLAUDE_BIN`
- `CLAUDE_COMMAND`
- `CLAUDE_PERMISSION_MODE`
- `COMMAND_TIMEOUT_MS`

`CODEX_BIN` defaults to `codex`, and `CLAUDE_BIN` defaults to `claude`. `CODEX_SANDBOX_MODE` may be set to `read-only`, `workspace-write`, or `danger-full-access`. If you need custom wrappers instead, set `CODEX_COMMAND` or `CLAUDE_COMMAND`.

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

## Development

```bash
npm install
npm run check
npm run build
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
