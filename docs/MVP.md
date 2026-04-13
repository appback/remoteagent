# MVP

## Objective

Build the first usable version of RemoteAgent as a personal installable session server that lets one owner continue the same AI work session across:

- the work PC
- Telegram
- a minimal local PC chat UI

The MVP is successful when the owner can start work on the PC, continue it from Telegram, return to the PC, and keep going from the same session context.

## Product boundary

This MVP is for:

- one owner
- one work PC
- local state only
- personal provider credentials only

This MVP is not for:

- multiple outside users
- hosted SaaS
- team collaboration
- billing, org management, or account sharing

## User story

1. I start or resume a session on my work PC.
2. I leave my desk and continue from Telegram.
3. I return to the PC and see the same session history and current state.
4. I switch providers per session without learning a different UI for each one.

## MVP pillars

### 1. Session server

The work PC runs a local process that owns:

- session records
- provider bindings
- message history
- workspace metadata
- routing between clients and providers

Minimum requirements:

- local state file or local lightweight database
- stable per-session identifier owned by RemoteAgent
- mapping from RemoteAgent session to provider session id
- append-only event log for messages and important actions

### 2. Telegram client

Telegram acts as a remote client to the session server.

Minimum requirements:

- create a session
- attach to an existing provider session
- view status
- send normal messages
- receive streamed or final responses in a usable way

Current commands already cover much of this:

- `/startpair`
- `/attach`
- `/status`
- `/mode`
- `/reset`

### 3. Local PC chat UI

The first PC UI can be minimal. It does not need to match official desktop apps.

Minimum requirements:

- list sessions
- open one session
- read the event history
- send a new message
- show current provider, workspace, and attached provider session id

Good enough for MVP:

- Electron app, local web app, or even a simple browser-based local UI

### 4. Provider adapters

The session server talks to providers through adapters.

MVP adapters:

- Codex
- Claude

Next adapter after MVP:

- OpenClaw

Minimum adapter contract:

- start or continue a provider session
- send one user message
- return provider output
- persist provider session id
- fail clearly when workspace or credentials are invalid

## Recommended implementation order

### Phase 1. Harden the current Telegram runtime

Target:

- reliable local process supervision
- better status output
- explicit session inspection
- import/export of session bindings

Acceptance:

- Telegram can create and resume Codex and Claude sessions reliably on the work PC
- local state survives restart

### Phase 2. Introduce RemoteAgent-owned session ids

Target:

- add a first-class RemoteAgent session record
- store provider bindings under that session
- stop treating Telegram chat id as the only top-level identity

Acceptance:

- one RemoteAgent session can outlive Telegram chat details
- provider session ids are internal bindings, not the primary user-facing identity

### Phase 3. Build the local PC chat UI

Target:

- simple local UI backed by the same session server
- same session can be viewed and continued from Telegram and the PC UI

Acceptance:

- a session started in the local UI can be continued from Telegram
- a session continued from Telegram can be reopened in the local UI

### Phase 4. Shared event history

Target:

- both channels read from the same event log
- messages sent from Telegram are visible in the PC UI
- messages sent from the PC UI are visible in Telegram where appropriate

Acceptance:

- the owner no longer has to guess which channel said what
- session history remains readable after restart

## Data model for MVP

Suggested top-level entities:

### Session

- `sessionId`
- `title`
- `createdAt`
- `updatedAt`
- `activeProvider`
- `workspace`
- `status`

### ProviderBinding

- `sessionId`
- `provider`
- `providerSessionId`
- `model`
- `cwd`
- `lastUsedAt`

### Event

- `eventId`
- `sessionId`
- `source` such as `telegram`, `pc-ui`, `provider`
- `direction` such as `in`, `out`, `system`
- `timestamp`
- `text`
- optional metadata

## Acceptance criteria

The MVP is done when all of the following are true:

1. A user can create a session on the work PC.
2. The same session can be resumed from Telegram.
3. The same session can later be resumed from the local PC chat UI.
4. Codex and Claude both work through the same session model.
5. Session history survives process restarts.
6. The local install remains single-user and local-first.

## Explicit non-goals for MVP

- hosted sync service
- shared cloud account pool
- multi-device conflict resolution
- mobile app
- exact parity with official Codex or Claude desktop UIs

## Nice-to-have after MVP

- OpenClaw adapter
- compare mode in the local UI
- file attachment handling
- searchable history
- local notifications
- session archive and restore tools
