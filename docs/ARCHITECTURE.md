# Architecture

## Intent

RemoteAgent is a personal installable runtime for six primary jobs:

1. Telegram control
2. terminal control
3. Telegram to Codex session continuity
4. Telegram to Claude Code session continuity
5. Telegram attachment intake for images, documents, and related files
6. Telegram Mini App UI over the same runtime state

The runtime machine is the source of truth.
Telegram is a client of that runtime, not the owner of the session state.
The Mini App is a richer client of the same runtime, not a separate backend.

## Core principles

1. One owner, one runtime, local control.
2. Sessions belong to the local runtime.
3. Telegram chat is a remote control surface over those sessions.
4. A Telegram Mini App is an optional structured UI over the same sessions.
5. Codex and Claude Code are adapters behind a shared local session model.
6. Terminal control is gated and attached to runtime-owned session state.
7. Telegram attachments are materialized locally before provider routing.
8. Process ownership must remain single-instance and deterministic.

## System shape

```text
Telegram chat client                  Telegram Mini App UI
        \                                   /
         \                                 /
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

### Telegram Mini App layer

Responsibilities:

- present the same sessions in a richer UI
- expose session lists, status, logs, and actions without relying on raw slash commands
- submit structured actions back to the runtime server
- stay thin: no provider execution, no separate session source of truth

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

## Mini App role

The Mini App should be treated as a control-plane UI for an already-installed runtime.

It is not:

- a replacement for the runtime server
- a hosted multi-tenant backend
- a place where provider CLIs run directly

It is:

- a Telegram-native web UI
- an easier way to view and manage sessions
- a better surface for logs, buttons, state, and attachments
- a future replacement for some slash-command-heavy workflows

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

Planned next:

- Telegram Mini App UI over existing runtime state
- structured session controls in Telegram beyond slash commands
- richer attachment and log inspection UX

Still improving:

- attachment response policy and user-facing output quality
- broader inspection and debugging UX
- future local PC chat UI maturity

## Non-goals

- hosted multi-tenant control plane
- account pooling or resale
- pretending RemoteAgent is the official Codex or Claude desktop product
- treating Telegram itself as the execution backend