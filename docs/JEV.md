# Optional Jev Integration

## Connect and Activate

Jev is a text decision API, not a coding provider. This integration uses OpenRouter,
not a TypeSafe direct API key. No SDK, daemon or model download is required.

1. Send `/install jev` for the built-in connection guide.
2. Send `/login`, select **Jev / OpenRouter**, and create a key at
   https://openrouter.ai/settings/keys.
3. In the owner's private Telegram chat, send `/login <OPENROUTER_API_KEY>`.
   The key must have the `sk-or-v1-` prefix. RemoteAgent attempts to delete the
   message, makes one small paid validation request, and stores a successful key
   as `OPENROUTER_API_KEY` in the existing server-wide Secret Store. Existing keys
   remain unchanged on validation failure. Deletion cannot retract all copies.
4. Send `/option jev observe` to evaluate reports without changing execution.
5. Set the acceptance threshold with `/option jev threshold 0.7` and correction
   budget with `/option jev retries 2`.
6. After evaluating representative reports, send `/option jev on` to enable
   review routing, or `/option jev off` to restore legacy behavior.
   `/option jev` shows mode, threshold, retry budget and key presence.

Default mode is **off**. Key registration does not enable the feature. Modes are
stored in `DATA_DIR/jev.json`, apply to all bots on that installation, and take
effect without restart. Server deployment and secret transfer are separate.

## Report Review

RemoteAgent sends seven atomic **Noul** questions in one call after a provider
invocation returns. This is not a Choice label with a separate confidence gate.
Each Noul value is the probability of a yes/true answer to its question.

| Question | Evaluated condition |
| --- | --- |
| aligned | Answers the current request rather than a different task |
| supported | Claims are supported by supplied evidence or reasoning |
| clear | Performed work, future plans and uncertainty are distinguished |
| complete | The requested scope is finished, without requiring unrequested extras |
| continuable | Requested work remains and can proceed without user intervention |
| needs_user | Input, authorization, credentials or external recovery is needed |
| improved | The previous review issues were substantively addressed, not reworded |

The default threshold is **0.7**, inclusive; configurable range is greater than
0.5 through 1. The runtime combines the answers as follows:

1. `needs_user` passes: return the report and wait. An explicit `REPORT:blocked`
   also remains blocked regardless of the assessment.
2. Any of aligned/supported/clear fails, or complete/continuable both pass or both
   fail: request verification and a corrected report.
3. Quality passes and complete passes: deliver the final result.
4. Quality passes and continuable passes: deliver progress and continue.

On mode evaluates tagged and untagged reports. `REPORT:result` alone no longer
bypasses review. The agent is asked for concise work/answer, evidence/reasoning,
remaining work and uncertainty. Simple questions need no artificial commit logs.
Corrections retain the current instruction and previous unresolved review, and
explicitly avoid undoing or repeating completed changes merely to pass a review.

The correction budget defaults to **2** additional responses per user work loop,
configurable from 0 to 5. After a correction, another failing review with
`improved < threshold` stops immediately. Otherwise failures stop at the retry
budget. The user receives the last report plus scores, unresolved items and stop
reason; the work is not recorded as completed. A fresh instruction starts a new
budget. Progress does not replenish it. Existing overall `/option retry` limits
can stop the loop earlier. `/stop`, session binding and approval remain authoritative.

Only the current request, returned report and most recent failed review are sent,
not accumulated history or repository files. Report evidence is explicitly marked
as agent-declared; transport metadata confirms a returned invocation, not a test or
deployment. The evaluator has no repository or execution tools. Its score is an
assessment of supplied material, not an independent execution audit.

- Observe mode logs scores and the suggested action without changing routing.
- Off mode makes no review call and adds no report guide.
- Unavailable, malformed, oversized and timed-out decisions retain legacy routing
  and output. Low Noul scores are valid review results, not API failures.
- The runtime permits one Jev request at a time, with a 3-second request timeout,
  no automatic HTTP retry and a 60-second cooldown after network/API failures.
  Agent CLI processes have their own bounded call; they do not share a daemon.

## Agent Tool

Both the harness and agent tool use `JevService`. Providers receive
`REMOTEAGENT_JEV_BIN` without an API key in that variable.

```sh
node "$REMOTEAGENT_JEV_BIN" status
node "$REMOTEAGENT_JEV_BIN" evaluate /absolute/request.json
# Equivalent installed CLI:
remoteagent jev status
remoteagent jev evaluate /absolute/request.json
```

Example `request.json`:

```json
{
  "inputType": "text",
  "state": {"description": "A vision tool describes a screenshot with an error banner."},
  "questions": {
    "error_visible": {
      "type": "noul",
      "instructions": "Does the supplied vision description explicitly identify a visible error banner? Do not infer unseen image details."
    }
  }
}
```

Supported question types are choice, score and noul. Local limits: 32 KiB request,
16 questions, 32 choice options, 2-10 score levels, 128 KiB response. The helper
returns `{available:true, answers, model}` or `{available:false, reason}`. Use
existing tools when unavailable. Input/file errors are nonzero CLI exits.
The helper returns raw answers. The caller can compare
`answers.error_visible.noul` against the threshold in `remoteagent jev status`;
it does not automatically start another provider execution.

Images are **unsupported**. `inputType: image` returns `image_unsupported` without
an API request. Image analysis stays with an existing vision tool; Jev can judge
only its supplied text description. Do not submit image bytes/base64, credentials,
or unnecessary private data. Judgments do not prove that work was actually done.

## Verification and Release

```sh
npm run build
node scripts/selftest-jev.mjs
npm run selftest:telegram
npm run selftest:cli
```

Tests use synthetic keys and mock APIs. They cover login/secret storage, redacted
logging, menu buttons, Noul routing, inclusive threshold, correction budget,
no-improvement stop, tagged results, approval, observe mode, legacy behavior, API
failures, bounded calls and image refusal. Live review accuracy requires
separate evaluation; Korean examples passing a small sample are not a guarantee.

Release using the existing [npm release procedure](RELEASING.md):
`npm run release:version -- patch`, commit and
push, then `npm run release:publish`. Publishing does not update running servers.

References:
- https://openrouter.ai/labs/jev/compile
- https://openrouter.ai/typesafe/jev-1.13
- https://docs.typesafe.ai/concepts/state (text-only; CJK accuracy caveat)
- https://docs.typesafe.ai/confidence
- https://docs.typesafe.ai/primitives/noul
