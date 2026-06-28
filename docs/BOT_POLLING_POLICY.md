# Telegram bot polling policy

RemoteAgent can run multiple Telegram bots in one runtime. Polling is the loop that asks Telegram whether each bot has new updates.

## Policy

When 4 or fewer bots are configured:

- every bot polls every 3 seconds

When 5 or more bots are configured:

- the 4 most recently messaged idle bots poll every 3 seconds
- the next 4 idle bots poll every 60 seconds
- all remaining idle bots poll every 180 seconds

When a bot has active provider work:

- that bot polls every 60 seconds
- `REPORT:progress` keeps it running
- `REPORT:result`, `REPORT:blocked`, timeout, fatal error, or `/stop` completion returns it to idle

## Removed concepts

RemoteAgent no longer uses deep sleep, wake, or a special main bot for polling control. All configured bots remain reachable through polling, just at different intervals.

## Operational notes

- `/bots` shows each configured bot and its polling state.
- `/bot doctor` removes bots that Telegram reports as permanently dead.
- `/bot remove <username|id>` removes a configured bot from the runtime.
- Polling state is stored by Telegram bot id, not by display order.
