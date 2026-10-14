# Same-server session dispatch

Agents can delegate an authorized task to another session through the installed
helper. The receiver executes through its Telegram work loop, including its queue,
stop controls, Jev review, typing, progress and final report delivery.

## Agent interface

Write the complete instruction to a UTF-8 file, then run:

```bash
node "$REMOTEAGENT_SESSION_BIN" list
node "$REMOTEAGENT_SESSION_BIN" send S007 /absolute/task.txt
node "$REMOTEAGENT_SESSION_BIN" status <receipt-UUID>
```

send prints a request UUID before HTTP delivery. Save it; if the HTTP response is
lost, reuse the SAME UUID with the same target/message:

```bash
node "$REMOTEAGENT_SESSION_BIN" send S007 /absolute/task.txt <original-request-UUID>
```

The sender session comes from REMOTEAGENT_SESSION_ID. The target is resolved by its
exact S-number or UUID. A nonexistent target returns SESSION_NOT_FOUND. A receiver
with one currently bound configured Telegram chat reports there. Without a Telegram
connection it still executes and returns its result to the sender. Multiple bound
Telegram destinations are rejected rather than guessed. Self-dispatch, active
delegation cycles and conflicting replay bodies are rejected.
Sending again with a new UUID is a new request; do not retry by silently generating
another UUID. A fresh user instruction is required to repeat externally committed work.

send waits for the receiver's response and returns the report in receipt.report.
The sender evaluates that response and continues its own work, or sends a specific
follow-up with a new request UUID if more work/correction is needed. This decision
belongs to the sender agent, not a keyword rule in RemoteAgent.

If connected, the receiver's Telegram displays the source, receipt ID and instruction
preview, then its own progress and result. Returning a response does not automatically
create a new model invocation in the sender: the waiting sender invocation consumes
the helper output. When interrupted, use status or replay the original request UUID.

## Receipt meaning

- accepted: accepted for asynchronous delivery; not proof of task completion
- running: receiver handler active, including time in its normal work queue
- reported: receiver work loop returned; when Telegram is connected its final
  delivery succeeded. receipt.report carries the same returned content to the sender;
  may report blocked, failed, cancelled or unverified work, not necessarily success
- failed: execution/report transport failed; inspect existing work before retry
- interrupted: runtime restarted; request is never automatically replayed

Task completion is assessed by the receiver's report/Jev. Receipt status is a
transport fact. Intermediate Telegram sends retain existing best-effort handling;
the receipt does not certify that every progress message arrived. Report text is
stored with receipts (mode 600); avoid sensitive values in reports. Up to 200 receipts
are retained; replay protection applies within that retained history, max 50 active.

## Runtime contract

LOCAL_UI_ENABLED must be enabled; LOCAL_UI_PORT defaults to 3794. The helper uses
loopback, reads DATA_DIR/dispatches/token locally, and never prints it or bot tokens.
Authenticated routes reject browser Origin headers:

- GET /api/dispatch-targets
- POST /api/dispatches {target,message,requestId}: 202 + receipt
- GET /api/dispatches/:id: receipt scoped to x-source-session

Bearer authentication and x-source-session identify the trusted local caller. This
is one owner/runtime; agents with the same OS account can read the same token, so
it is not isolation against a hostile same-account agent. This does not extend
cross-server /peer authorization or grant permission to contact people. Providers
must delegate only within the user's authorized scope.

Use this interface for agent delegation rather than raw /api/sessions/:id/messages.
That legacy PC UI endpoint remains a single provider call and has different semantics.
The helper is an installed Node entrypoint, not an additional polling daemon.

## Verification

```bash
npm run build
node scripts/selftest-session-dispatch.mjs
node scripts/selftest-telegram-update.mjs
```

Tests verify concurrent replay, cycle/self rejection, receipt scope, HTTP auth,
restart without replay, transport failure and receiver Telegram progress/final
delivery through Jev continuation. Telegram and provider calls are mocked; production
delivery and real evaluator behavior require separate deployment verification.
