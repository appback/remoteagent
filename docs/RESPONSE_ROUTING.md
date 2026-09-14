# Provider response routing

RemoteAgent uses the explicit first-line REPORT marker to route provider replies.

- `REPORT:progress`: forward progress and continue within the configured automatic continuation limit.
- `REPORT:result`: forward the final reply and end the turn.
- `REPORT:blocked`: forward the reply and end the turn.
- Missing marker: forward the reply as final output.

The response body is not used to decide whether work happened, whether evidence is adequate, or whether the provider needs permission. Evidence remains a provider reporting instruction, not a delivery gate. Recording a final reply does not certify project completion.

Repeated progress text is deduplicated for delivery. It does not override the explicit status. The configured continuation limit, user stop requests, and session binding checks control further executions.

The retired `/option intent` command returns a compatibility notice. Existing `TELEGRAM_UNTAGGED_INTENT_RETRIES` values no longer trigger executions.

## Verification

Run `npm run selftest:telegram` to exercise S091 requirement corrections and negations, final replies without evidence, untagged replies, explicit progress and blocked states, queued instruction removal, timeout handling, and stopping an active progress turn.

The S091 incident was caused by body regexes matching both "정리했습니다" and "완료 보고가 아닙니다" as completion claims. Those classifiers and their corrective retry prompts have been removed rather than expanded with word exceptions.
