# Codex Model Upgrade

## GPT-6.1 Sol

RemoteAgent 0.32.1 adds `gpt-6.1-sol` to `/model`, makes it the default for new
Codex sessions, forwards reasoning effort on exec/resume and includes the effort
in report headers. Existing reasoning settings and the usage-limit fallback
policy are retained. Claude sessions are unchanged.

## Verified Deployment, 2026-10-23 KST

Release commit `2c288ec` was published as npm 0.32.1 with the canonical release
script. All release gates passed, including Codex stream/reasoning, usage fallback,
offline migration lock, Telegram injection and G2 browser regressions. Registry
verification completed on check 25 without republishing or changing credentials.

| Server | RemoteAgent | Codex CLI | Migrated Codex sessions |
| --- | --- | --- | --- |
| 192.168.33.30 | 0.32.1 | 0.164.0 | 20 |
| 192.168.33.40 | 0.32.1 | 0.164.0 | 11 |
| 192.168.33.50 | 0.32.1 | 0.164.0 | 2 |
| 192.168.33.60 | 0.32.1 | 0.164.0 | 11 |
| 192.168.33.110 | 0.32.1 | 0.164.0 | 3 |

All 47 sessions now store `gpt-6.1-sol`. On every host, a comparison against the
private pre-migration backup confirmed the model was the only state change.
Temporary fallback state was backed up if present and cleared. An isolated
read-only CLI request to `gpt-6.1-sol` with medium reasoning returned exactly
`MODEL_OK` with exit code 0 on all five hosts. This used separate disposable
probe workspaces, not the user's existing Codex threads.

SSH to `192.168.33.20` and `.26` returned No route to host; no update was applied
there. These addresses must not be described as successfully upgraded.

## Repeatable Commands

Publish and deploy the npm package through RELEASING.md first:

```bash
npm run release:deploy -- 0.32.1 60
```

Then run the maintenance script as the RemoteAgent OS account. For Mac60:

```bash
ssh appback@192.168.33.60 'bash -s -- 0.164.0' \
  < scripts/apply-codex-model-upgrade.sh
```

Use the same command with the relevant SSH account for other hosts. The script
checks idle state and child processes, updates the exact CLI version, stops the
existing service, acquires the runtime lock, backs up state, changes all existing
Codex session models and clears backed-up temporary fallback state. It restarts
the same service and verifies the installed version and every Codex model.
Session/thread IDs, workspaces, chats, secrets, OAuth and Claude are preserved.
Active work aborts the operation; retry after that work finishes.

The shipped offline primitive can also be used while the service is stopped:

```bash
node "$(npm root -g)/appback-remoteagent/scripts/set-codex-model.mjs" \
  gpt-6.1-sol "$HOME/.remoteagent"
```

The primitive rejects a live RemoteAgent owner, backs up state and updates both
state.json and per-session records via FileStore. Repeating it is idempotent.
