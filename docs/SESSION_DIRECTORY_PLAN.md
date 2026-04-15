# Session Directory Plan

## Decision

RemoteAgent should move to a hybrid model:

- session-owned storage as the source of truth
- bot-scoped bindings as the entry point

In practice:

- directories are owned by RemoteAgent sessions
- each Telegram bot keeps its own chat bindings and defaults
- a bot/chat points to a current session

This matches the core product goal better than bot-owned directories because the main UX target is continuing the same work across:

- work PC UI
- Telegram bot A
- Telegram bot B

without fragmenting one task into separate storage roots.

## Why not bot-owned directories?

Bot-owned directories make sense for policy isolation, but they are a weaker fit for the primary workflow:

1. the same work should survive switching between PC and Telegram
2. the same work may later move between different Telegram bots
3. future PC UI should not be forced to pretend to be a bot

If storage is bot-owned, the system tends to duplicate:

- event history
- session metadata
- attachments
- provider bindings

and cross-bot continuation becomes an explicit migration instead of a normal action.

## Recommended model

### Source of truth

The source of truth should be the RemoteAgent session.

Each session owns:

- workspace metadata
- provider bindings
- event history
- attachments and exports
- derived session state

### Bot responsibility

Each Telegram bot should own:

- bot identity and policy
- bot-level defaults
- mappings from `(platform, bot, chat)` to `sessionId`

That gives the desired UX:

- users feel each bot is separately managed
- the underlying work remains session-centric

## Target data model

### 1. BotProfile

Represents one configured Telegram bot.

Suggested fields:

```ts
type BotProfile = {
  botId: string;              // internal id, usually Telegram bot user id or username
  platform: "telegram";
  username?: string;          // e.g. codex_remoteagent_bot
  tokenLabel?: string;        // optional human-friendly label, never the secret token
  ownerUserId?: string;
  enabled: boolean;
  defaults: {
    mode: BridgeMode;
    workspace?: string;
    provider?: Provider;
    codexSandboxMode?: CodexSandboxMode;
  };
  policy: {
    allowRemoteShell: boolean;
    privateOnly: boolean;
  };
  createdAt: string;
  updatedAt: string;
};
```

### 2. ChannelBinding

Represents one external client channel bound to a RemoteAgent session.

Suggested fields:

```ts
type ChannelBinding = {
  bindingId: string;
  platform: "telegram" | "pc-ui";
  botId?: string;             // required for telegram, omitted for local UI
  chatId: string;             // Telegram chat id or PC UI client id
  sessionId: string;
  title?: string;
  state: "active" | "archived";
  boundAt: string;
  updatedAt: string;
};
```

Key change from current model:

- today the top-level mapping is effectively `chatId -> sessionId`
- target model is `(platform, botId, chatId) -> sessionId`

This is the critical change needed for multi-bot correctness.

### 3. SessionRecord

Represents the canonical RemoteAgent session.

Suggested fields:

```ts
type SessionRecord = {
  sessionId: string;
  title?: string;
  mode: BridgeMode;
  workspace: string;
  status: "active" | "archived";
  activeChannel?: {
    platform: "telegram" | "pc-ui";
    botId?: string;
    chatId: string;
  };
  codex?: ProviderSession;
  claude?: ProviderSession;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};
```

### 4. ProviderSession

This stays similar to the current model, but should become session-owned only.

```ts
type ProviderSession = {
  provider: Provider;
  cwd: string;
  pairedAt: string;
  sessionId?: string;         // provider's own id
  model?: string;
  lastUsedAt?: string;
  sandboxMode?: CodexSandboxMode;
};
```

### 5. SessionEvent

This replaces the current flat JSONL log shape conceptually, even if JSONL stays as the storage format.

```ts
type SessionEvent = {
  eventId: string;
  sessionId: string;
  timestamp: string;
  source: "telegram" | "pc-ui" | "codex" | "claude" | "system";
  direction: "in" | "out" | "system";
  actor?: {
    botId?: string;
    chatId?: string;
    providerSessionId?: string;
  };
  text: string;
  metadata?: Record<string, string | number | boolean | null>;
};
```

## Target on-disk layout

Today the installed runtime stores most state in:

- `state.json`
- `logs/<sessionId>.jsonl`

Target layout should become:

```text
~/.remoteagent/
  config/
    bots.json
  channels/
    telegram/
      <bot-id>/
        <chat-id>.json
    pc-ui/
      <client-id>.json
  sessions/
    <session-id>/
      session.json
      events.jsonl
      attachments/
      exports/
  migrations/
    applied.json
```

### Directory ownership

#### `config/bots.json`

Stores configured bot profiles and bot-level defaults.

#### `channels/telegram/<bot-id>/<chat-id>.json`

Stores one Telegram chat binding per bot.

This is the main answer to the user's requirement:

- Telegram bot A and Telegram bot B are managed separately
- but they can still point to the same `sessionId`

#### `sessions/<session-id>/session.json`

Stores canonical session metadata.

#### `sessions/<session-id>/events.jsonl`

Stores append-only history for that one session.

#### `sessions/<session-id>/attachments/`

Stores future uploaded files, screenshots, exports, and attachment metadata.

## Example

One user may have:

- `@codex_remoteagent_bot`
- `@sqream_bot`

Both can point at the same session:

```text
channels/telegram/codex_remoteagent_bot/8202993989.json -> sessionId=S1
channels/telegram/sqream_bot/8202993989.json            -> sessionId=S1
sessions/S1/session.json
sessions/S1/events.jsonl
```

This preserves:

- separate bot routing
- shared work history
- one workspace and one session identity

## Required code changes

### A. Types

Current relevant file:

- `src/types.ts`

Required changes:

1. add `BotProfile`
2. replace `ChatBinding` with `ChannelBinding`
3. add `platform` and `botId`
4. split session event type from provider response type
5. add `status` and `activeChannel` to `SessionRecord`

### B. Store layer

Current relevant file:

- `src/store/file-store.ts`

Required changes:

1. stop using one `state.json` as the only state source
2. add directory-backed reads and writes for:
   - bot profiles
   - channel bindings
   - session records
   - session event logs
3. add lookup by:
   - `sessionId`
   - `(platform, botId, chatId)`
4. add session listing independent of Telegram chats
5. add migration from legacy `state.json`

### C. Bridge service

Current relevant file:

- `src/services/bridge-service.ts`

Required changes:

1. route messages through `(platform, botId, chatId)`
2. treat chat binding as a client pointer, not as session ownership
3. add APIs for:
   - create session
   - bind channel to existing session
   - switch a bot/chat to another session
   - list sessions for UI and Telegram commands
4. write all incoming and outgoing traffic as session events

### D. Bot runtime

Current relevant files:

- `src/index.ts`
- `src/bot.ts`
- `src/config.ts`

Required changes:

1. keep multiple Telegram bots running at once
2. assign each bot a stable `botId`
3. include that `botId` when calling the bridge
4. expose future bot-scoped commands like:
   - `/session`
   - `/new`
   - `/switch`
   - `/archive`

### E. Local UI

Current relevant file:

- `src/services/local-ui-service.ts`

Required changes:

1. list canonical sessions, not chats
2. show bound channels under a session
3. open one session and read `events.jsonl`
4. allow binding or rebinding Telegram chats later

## Migration plan

### Phase 1. Add the new directory model alongside legacy state

Goal:

- introduce new store layout without breaking the current bot flow

Work:

1. create `config/`, `channels/`, and `sessions/`
2. on startup, read legacy `state.json` if present
3. materialize equivalent:
   - session directories
   - Telegram channel binding files
4. keep writing both formats temporarily

### Phase 2. Switch reads to the new store

Goal:

- make directory-backed storage the primary source

Work:

1. read sessions from `sessions/<id>/session.json`
2. read Telegram bindings from `channels/telegram/<bot-id>/<chat-id>.json`
3. read events from per-session `events.jsonl`
4. stop depending on `state.json` for live behavior

### Phase 3. Remove dual-write and archive legacy state

Goal:

- simplify the runtime after migration is stable

Work:

1. write migration marker in `migrations/applied.json`
2. move legacy `state.json` to `state.legacy.json`
3. keep a recovery path, but no longer write the old format

## Telegram command implications

Current commands can stay, but semantics should be clarified.

### `/startpair codex [path]`

Recommended target behavior:

- create a new RemoteAgent session if the current bot/chat has no binding
- otherwise update the current session's Codex provider binding

### `/attach codex <thread_id> [path]`

Recommended target behavior:

- attach the provider binding inside the current session
- optionally support `--session <session-id>` later

### New commands worth adding

1. `/session`
   - show the current bound session id and title
2. `/new [path]`
   - create a new RemoteAgent session and bind this bot/chat to it
3. `/switch <session-id>`
   - rebind this bot/chat to another existing session
4. `/sessions`
   - list recent sessions available to this owner
5. `/archive [session-id]`
   - archive a session without deleting history

## Recommendation for implementation order

### Step 1

Add `botId` into the live routing path first.

This fixes the biggest correctness gap introduced by multi-bot support.

### Step 2

Move from flat `state.json` to:

- `channels/telegram/<bot-id>/<chat-id>.json`
- `sessions/<session-id>/session.json`

### Step 3

Move logs from `logs/<sessionId>.jsonl` to:

- `sessions/<session-id>/events.jsonl`

### Step 4

Add session listing and session switching commands.

### Step 5

Teach the local UI to read sessions directly.

## Concrete MVP TODO

### Data model

- [ ] add `BotProfile`
- [ ] add `ChannelBinding`
- [ ] extend `SessionRecord` with `status`, `title`, and `activeChannel`
- [ ] rename `LogEntry` to a session-owned event model

### Storage

- [ ] add `config/bots.json`
- [ ] add `channels/telegram/<bot-id>/<chat-id>.json`
- [ ] add `sessions/<session-id>/session.json`
- [ ] add `sessions/<session-id>/events.jsonl`
- [ ] keep legacy import from `state.json`

### Runtime

- [ ] resolve stable `botId` from each initialized Telegram bot
- [ ] pass `botId` into every bridge operation
- [ ] update remote shell guardrails to be bot-aware
- [ ] update status formatting to show bot-scoped bindings

### Commands

- [ ] add `/session`
- [ ] add `/sessions`
- [ ] add `/new`
- [ ] add `/switch`
- [ ] add `/archive`

### UI

- [ ] list canonical sessions in the local UI
- [ ] show bound Telegram channels under each session
- [ ] open and read shared event history

### Migration

- [ ] auto-migrate legacy `state.json`
- [ ] dual-write temporarily
- [ ] cut over to directory-backed reads
- [ ] remove legacy write path

## Final recommendation

For RemoteAgent, the right answer is:

- manage Telegram bots separately at the binding layer
- manage work separately at the session layer

So the product should feel "bot-specific" from the user's point of view, while the storage model remains session-centric underneath.
