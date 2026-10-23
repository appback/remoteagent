# Codex Model Upgrade

## GPT-6.1 Sol

RemoteAgent 0.32.1 adds `gpt-6.1-sol` to `/model`, makes it the default for new
Codex sessions, forwards reasoning effort on exec/resume and includes the effort
in report headers. Existing reasoning settings and the usage-limit fallback
policy are retained. Claude sessions are unchanged.

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
