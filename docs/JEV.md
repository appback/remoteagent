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
5. After evaluating representative reports, send `/option jev on` to enable
   classification of untagged responses, or `/option jev off` to restore legacy
   behavior. `/option jev` shows current mode and key presence without a value.

Default mode is **off**. Key registration does not enable the feature. Modes are
stored in `DATA_DIR/jev.json`, apply to all bots on that installation, and take
effect without restart. Server deployment and secret transfer are separate.

## Report Handling

- Only classify a response after the provider invocation returns. Running process
  state is managed by RemoteAgent, not inferred by Jev.
- Send the current user instruction and returned report, not accumulated history
  or repository files. The content leaves the server for OpenRouter/TypeSafe.
- Observe mode logs the suggested classification, confidence and fallback reason;
  it does not change continuation. It can evaluate tagged responses for comparison.
- On mode preserves explicit `REPORT:progress`, `REPORT:result`, `REPORT:blocked`.
  Untagged responses can become progress/result/blocked only when both confidence
  and the selected probability are at least 0.9. Otherwise use existing behavior.
  This threshold is an initial conservative policy, not an accuracy guarantee.
- Stop and chat-binding checks run again after the API call. Existing continuation
  limits remain in force. There is no additional Jev retry/repair loop.
- Disabled, unavailable, malformed, oversized, low-confidence and timed-out
  decisions retain the original report classification and output text.
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
    "classification": {
      "type": "choice",
      "instructions": "Classify the supplied description; do not infer unseen image details.",
      "criteria": {
        "error": "An error is explicitly described.",
        "normal": "Normal operation is explicitly described.",
        "unknown": "Insufficient description."
      }
    }
  }
}
```

Supported question types are choice, score and noul. Local limits: 32 KiB request,
16 questions, 32 choice options, 2-10 score levels, 128 KiB response. The helper
returns `{available:true, answers, model}` or `{available:false, reason}`. Use
existing tools when unavailable. Input/file errors are nonzero CLI exits.

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
logging, menu buttons, opt-in continuation, observe mode, legacy behavior, API
failures, bounded calls and image refusal. Live classification accuracy requires
separate evaluation; Korean examples passing a small sample are not a guarantee.

Release using the existing [npm release procedure](RELEASING.md):
`npm run release:version -- patch`, commit and
push, then `npm run release:publish`. Publishing does not update running servers.

References:
- https://openrouter.ai/labs/jev/compile
- https://openrouter.ai/typesafe/jev-1.13
- https://docs.typesafe.ai/concepts/state (text-only; CJK accuracy caveat)
- https://docs.typesafe.ai/confidence
