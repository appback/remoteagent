# Telegram Mini App Plan

## Positioning

RemoteAgent should treat a Telegram Mini App as a richer control UI for the same installable runtime.

It should not be described as:

- a standalone hosted app
- a replacement for the runtime server
- a separate agent execution environment

It should be described as:

- a Telegram-native web UI
- an optional control plane for the installed runtime
- a structured companion to the existing Telegram bot chat

## Why it fits RemoteAgent

RemoteAgent already has:

- Telegram bot identity and chat entry points
- persisted sessions
- session switching
- provider metadata
- stop and continue controls
- attachment history
- event logs

A Mini App can expose those features more clearly than raw commands.

## First MVP

The first Mini App should focus on runtime visibility and control, not on replacing chat.

### MVP screens

1. Session list
   - public session id
   - provider mode
   - workspace label
   - updated time

2. Session detail
   - current provider
   - model
   - sandbox state
   - workspace path summary
   - provider binding state

3. Activity view
   - recent event log items
   - progress/result/blocked states
   - attachment entries

4. Actions
   - switch session
   - continue
   - stop
   - new session
   - reset binding

## Runtime boundary

The Mini App should call runtime-owned APIs.
It should not directly execute Codex, Claude Code, or shell commands on its own.

The runtime remains responsible for:

- provider execution
- session storage
- authorization
- attachment download and send
- error normalization

## Authentication model

The Mini App should trust Telegram launch context only as an input signal.
Runtime-side checks still matter.

Expected checks:

- Telegram user id matches `TELEGRAM_OWNER_ID` for privileged actions
- current bot/chat context maps to the expected runtime channel
- action is valid for the target session

## Suggested rollout

### Phase 1

- menu button launches Mini App
- read-only session list and session detail
- stop and continue buttons

### Phase 2

- attachment history
- structured model selection
- better progress log browsing

### Phase 3

- richer batch composition
- per-session settings views
- safer admin flows for bot/runtime management

## Non-goals

- replacing Telegram chat entirely
- multi-user SaaS dashboard
- separate hosted control plane detached from the runtime machine