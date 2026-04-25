# MVP

## Objective

The MVP is a usable personal runtime that proves five things together:

1. Telegram can control the runtime
2. the owner can use terminal control safely
3. Telegram can continue Codex work
4. Telegram can continue Claude Code work
5. Telegram can pass images and documents into the active session flow

Success means the owner can work on their machine, continue from Telegram, and return without losing the local runtime context.

## Product boundary

This MVP is for:

- one owner
- one installable local runtime
- personal provider credentials
- local state only

This MVP is not for:

- hosted SaaS
- external users
- team billing or org management
- account sharing

## MVP pillars

### 1. Telegram control

Minimum requirements:

- create or bind a local session from Telegram
- inspect status
- switch sessions
- reset a chat binding
- send normal Telegram text messages into the active provider session

### 2. Terminal control

Minimum requirements:

- run shell commands from Telegram
- keep this owner-only
- keep this private-chat-only
- tie dangerous shell access to the current Codex sandbox policy

### 3. Codex integration

Minimum requirements:

- start a fresh Codex pairing
- attach to an existing Codex `thread_id`
- continue the same Codex session across turns
- keep workspace metadata with the session

### 4. Claude Code integration

Minimum requirements:

- start a fresh Claude pairing
- attach to an existing Claude `session_id`
- continue the same Claude session across turns
- keep workspace metadata with the session

### 5. Attachment intake

Minimum requirements:

- accept Telegram photos and supported files
- materialize them locally in runtime-owned storage
- route them through the active session flow
- avoid leaking internal local paths in normal user-facing replies when possible

## Supporting runtime requirements

To make the five pillars actually usable, the runtime also needs:

- local session persistence
- provider binding persistence
- append-only event logs
- stable runtime-owned session ids
- deterministic single-instance process ownership
- recoverable restart behavior

## Acceptance criteria

The MVP is done when all of the following are true:

1. Telegram can control a local runtime session reliably.
2. Terminal control works under explicit restrictions.
3. Codex can be paired or attached from Telegram.
4. Claude Code can be paired or attached from Telegram.
5. Telegram image/document inputs reach the active session flow.
6. Restarts do not create ambiguous multi-process ownership.
7. Session state survives process restarts.

## Explicit non-goals

- hosted sync service
- public multi-user bot service
- account resale
- exact parity with official desktop apps
- turning RemoteAgent into a general-purpose terminal file manager
