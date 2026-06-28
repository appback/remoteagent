# Telegram polling policy TODO

## Goal

Simplify multi-bot polling so RemoteAgent can keep many Telegram bots configured without deep sleep, wake commands, or a special main bot.

## Required policy

- If configured bot count is 4 or less, every bot polls every 3 seconds.
- If configured bot count is 5 or more:
  - the 4 most recently messaged idle bots poll every 3 seconds
  - the next 4 idle bots poll every 60 seconds
  - all remaining idle bots poll every 180 seconds
- A bot with active provider work polls every 60 seconds.
- `REPORT:progress` keeps the bot in running state.
- Running state ends only after final result, blocked result, fatal error, timeout, or `/stop` completion.

## Removed concepts

- No deep sleep state.
- No wake command.
- No main bot requirement.
- No separate sleep registry.

## Steps

1. Remove user-facing `/sleep`, `/wake`, and `/bot main` commands from help and command menu.
2. Remove main/deep-sleep logic from bot management output and environment writing.
3. Track bot provider activity as idle/running in the polling state file.
4. Replace idle-threshold polling with rank-based polling.
5. Update README, operations docs, and `.env.example`.
6. Run local checks only. Do not deploy to server 30 until explicitly requested.

## Local validation

- `npm run check`
- `npm run build`
- Confirm `/bots` output no longer shows main/sub or deep sleep.
- Confirm rank-based interval calculation is covered by a local test or deterministic helper check.

## Deployment rule

Server 30 deployment is intentionally out of scope for this change until the operator explicitly requests it.
