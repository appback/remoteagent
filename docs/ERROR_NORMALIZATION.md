# Error Normalization

RemoteAgent should never leak raw provider event payloads directly to Telegram users.

## Goals

- normalize provider failures into stable user-facing messages
- classify retryable vs non-retryable failures
- keep internal details in logs, not in Telegram replies
- make retry behavior predictable for long-running Telegram sessions
- tell users when a retryable issue is being retried and when automatic retries stop

## Current retryable classes

- `provider.capacity.retryable`
  - example: `Selected model is at capacity`
  - behavior: send a progress-style retry notice, wait, retry automatically
- `provider.empty_response.retryable`
  - example: provider returned no usable final text after progress
  - behavior: send a progress-style retry notice, wait, retry automatically
- `provider.timeout.final`
  - example: `Codex timed out after 600s without returning a final reply`
  - behavior: do not retry automatically; explain the exact configured timeout that killed the provider process

## Current terminal behavior

When retries are exhausted:

- capacity -> ask the user to retry later or switch models
- empty response -> explain that automatic continuation stopped after repeated empty follow-up replies

When a provider process reaches `COMMAND_TIMEOUT_MS`:

- report that the provider process exceeded the configured execution timeout
- do not say only that "response was delayed"
- do not invent a cause such as context compaction, provider outage, or model quality unless the provider output explicitly says that
- tell the operator to increase `/option timeout <seconds>` for long-running work

## Maintenance rule

When a new provider error shape appears:

1. capture the raw provider output in logs
2. add a stable classifier
3. map it to a retry policy or a final user-facing message
4. keep raw JSON and internal event envelopes out of Telegram replies
