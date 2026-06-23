# Telegram Bot Sleep

## Why this exists

RemoteAgent can run multiple Telegram bots in one runtime.
Each active bot needs Telegram polling.

Operationally, up to three active polling bots has been stable enough.
When more than three bots are active, polling pressure and Telegram transport errors become more likely.

Sleep exists to reduce polling load without deleting bot configuration.

## Definitions

- main bot: the control bot that stays reachable
- sub bot: any configured bot that is not the main bot
- awake: the bot is polled normally
- deep sleep: the bot is configured but not polled

Sleep is not removal.
Removing a bot deletes it from runtime configuration.
Sleeping a bot keeps the bot registered and preserves its sessions.

## Policy

1. The main bot must not enter deep sleep.
2. Sub bots may enter deep sleep.
3. The main bot can wake a sleeping sub bot.
4. Bot doctor and sleep are separate features.
5. Bot doctor may remove permanently invalid Telegram bots.
6. Sleep must never remove a bot token or session state.
7. User-facing list output should show bot role and sleep state.

## Polling Strategy

The intended strategy is tiered:

1. recently used bots poll normally
2. idle bots poll less often
3. manually sleeping bots do not poll

This lets frequently used agents stay responsive while long-idle agents stop consuming polling capacity.

## Commands

Command surface:

```text
/sleep <bot>
/wake <bot>
/bot main <bot>
/bots
/list
```

Expected behavior:

- `/sleep <bot>` puts a sub bot into deep sleep
- `/sleep` without a target may sleep the current bot only when it is not the main bot
- `/wake <bot>` wakes a sleeping sub bot
- `/bots` shows main/sub and awake/sleeping state
- `/list` shows session state and bot state where relevant

## Non-goals

- Do not infer sleep from natural-language provider replies.
- Do not treat sleep as `/bot remove`.
- Do not let Codex or Claude decide which bot should be removed.
- Do not create a separate sleep-only bot registry that can drift from configured bots.

## Implementation Notes

Sleep state should be keyed by stable Telegram bot id, not by display index.

Display indexes are only for user convenience.
Internal actions must resolve to bot id.

The runtime should still keep one always-awake control path through the main bot.
