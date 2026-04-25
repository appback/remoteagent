# Architecture

## Intent

RemoteAgent is a personal installable runtime for five primary jobs:

1. Telegram control
2. terminal control
3. Telegram to Codex session continuity
4. Telegram to Claude Code session continuity
5. Telegram attachment intake for images, documents, and related files

The runtime machine is the source of truth.
Telegram is a client of that runtime, not the owner of the session state.

## Core principles

1. One owner, one runtime, local control.
2. Sessions belong to the local runtime.
3. Telegram is a remote control surface over those sessions.
4. Codex and Claude Code are adapters behind a shared local session model.
5. Terminal control is gated and attached to runtime-owned session state.
6. Telegram attachments are materialized locally before provider routing.
7. Process ownership must remain single-instance and deterministic.

## System shape

```text
Telegram client
  -> RemoteAgent runtime on the owner machine
       -> session store
       -> chat/session bindings
       -> event logs
       -> attachment store
       -> provider router
       -> owner-only terminal gateway
       -> Codex adapter
       -> Claude Code adapter
       -> future providers
```

## Main subsystems

### Telegram control layer

Responsibilities:

- accept Telegram commands and messages
- bind chats to runtime sessions
- expose status/list/switch/reset flows
- accept attachments and route them to the active session
- gate privileged commands such as remote shell

### Session layer

Responsibilities:

- own RemoteAgent session ids
- persist workspace metadata
- track provider bindings
- record append-only event history
- serialize work per session when needed

### Provider adapter layer

Responsibilities:

- start or continue provider sessions
- translate runtime requests into provider-specific commands
- store provider session identifiers such as Codex `thread_id` and Claude `session_id`
- return normalized outputs back to the runtime

### Terminal control layer

Responsibilities:

- execute owner-only shell commands in the active workspace
- enforce private-chat and owner-only restrictions
- keep terminal access tied to Codex danger-full-access mode

### Attachment layer

Responsibilities:

- download Telegram-hosted files
- store them under runtime-owned local paths
- build attachment prompts for the active provider flow
- keep internal runtime paths out of user-facing responses where possible

## Provider support today

| Provider | Current state | Resume identifier | Notes |
| --- | --- | --- | --- |
| Codex | Implemented | `thread_id` | Supports Telegram sandbox control and remote-shell gating |
| Claude Code | Implemented | `session_id` | Supports attach/resume through the same runtime model |
| OpenClaw | Planned | TBD | Not yet implemented |

## Operational constraints

The runtime must behave as a single owned process.

That means:

- `systemd` owns the production runtime on server 30
- ad hoc duplicate `node dist/index.js` processes must not coexist
- stale PID and stale lock state must not become the effective source of truth
- image and attachment incidents must be debugged against one live process generation, not many

The production operating rules are documented in [OPERATIONS.md](./OPERATIONS.md).

## Current status

Stable today:

- Telegram control
- owner-only terminal control
- Telegram <-> Codex session handling
- Telegram <-> Claude Code session handling
- Telegram attachment download and local materialization
- single-instance runtime locking on server 30

Still improving:

- attachment response policy and user-facing output quality
- broader inspection and debugging UX
- future local PC chat UI maturity

## Non-goals

- hosted multi-tenant control plane
- account pooling or resale
- pretending RemoteAgent is the official Codex or Claude desktop product
