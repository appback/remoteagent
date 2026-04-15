# Architecture

## Intent

RemoteAgent is a personal installable runtime for continuing the same AI work session across:

- the work PC
- Telegram
- a future local PC chat UI

The work PC is the source of truth.

## Core principles

1. One owner, one machine, local control.
2. Sessions belong to the local runtime, not to a hosted backend.
3. Channels such as Telegram and the future PC UI are clients of the same session server.
4. Providers such as Codex, Claude, and OpenClaw are adapters behind a shared model.
5. Workspaces, session ids, logs, and routing state are persisted locally.

## System shape

```text
                           +----------------------+
                           |   Telegram Client    |
                           +----------+-----------+
                                      |
                                      v
                    +---------------------------------------+
                    | RemoteAgent Session Server            |
                    | running on the work PC               |
                    |                                       |
                    | - chat/session registry               |
                    | - local state store                   |
                    | - message log                         |
                    | - provider router                     |
                    | - workspace guardrails                |
                    +----+----------------+-----------------+
                         |                |
                         |                +----------------------+
                         v                                       v
              +------------------+                    +------------------+
              | Codex Adapter    |                    | Claude Adapter   |
              +------------------+                    +------------------+
                         |
                         +----------------------+
                                                |
                                                v
                                      +------------------+
                                      | OpenClaw Adapter |
                                      | planned          |
                                      +------------------+

                    future:
                    +----------------------+
                    | Local PC Chat UI     |
                    +----------------------+
```

## Session model

Each Telegram chat maps to one logical session binding.

The next-step directory-backed session plan is documented in [SESSION_DIRECTORY_PLAN.md](./SESSION_DIRECTORY_PLAN.md).

Current stored data per provider includes:

- provider
- workspace path
- paired time
- session id or thread id
- model
- last used time

The same model is intended to back the future PC chat UI.

## Current behavior

### Supported providers today

| Provider | Current state | Resume identifier | Notes |
| --- | --- | --- | --- |
| Codex | Implemented | `thread_id` | Supports per-chat sandbox selection in Telegram |
| Claude Code | Implemented | `session_id` | Resume depends on matching workspace |
| OpenClaw | Planned | TBD | Not implemented in the current runtime |

### Fresh pairing

- `/startpair codex [path]`
- `/startpair claude [path]`
- `/startpair both [path]`

This creates or resets a provider binding for that Telegram chat. The first real user message creates the underlying provider session if needed.

### Existing-session attach

- `/attach codex <thread_id> [path]`
- `/attach claude <session_id> [path]`

This binds the Telegram chat to an already existing provider session and continues from that stored context.

### Restricted remote shell

- `/! <command>`
- `/!cmd <command>`
- `/!bash <command>`

This feature is intentionally gated:

- bot owner only
- private 1:1 Telegram chats only
- only when the current Codex session sandbox is `danger-full-access`

## Planned evolution

### Near term

- improve status output
- stronger session inspection tools
- export/import session bindings
- safer process supervision

### Medium term

- local PC chat UI using the same session server
- OpenClaw adapter
- richer compare mode
- attachment handling and file references

### Long term

- a true session-centric UX where Telegram and PC UI are peers
- shared event history across channels
- local-first tooling around one session record

## Non-goals

- multi-tenant hosted backend
- account resale
- using one personal account to serve multiple outside users
- claiming exact internal parity with official desktop UIs
