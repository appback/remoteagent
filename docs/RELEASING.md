# RemoteAgent Release Runbook

This runbook is command-first. Use the scripts below as the release interface.

## 1. Bump Version

Patch release:

```bash
npm run release:version -- patch
```

Minor release:

```bash
npm run release:version -- minor
```

Major release:

```bash
npm run release:version -- major
```

Versioning guide:

- `patch`: reliability fixes, bug fixes, text fixes, safe maintenance
- `minor`: new commands, new user-facing behavior, new non-breaking workflow
- `major`: storage/runtime contract changes or breaking command behavior

## 2. Validate

```bash
npm run check
npm run build
```

## 3. Commit And Push

```bash
git status --short
git add -A
git commit -m "Release <version>"
git push origin main
```

Example:

```bash
git commit -m "Release 0.15.5"
```

## 4. Publish To npm

Load the npm token when the shell has not loaded it yet:

```bash
source ~/.config/remoteagent/npm-token.env
```

Publish:

```bash
npm run release:publish
```

The publish script performs:

- tracked working tree check
- a clean staging snapshot from committed `HEAD`; unrelated untracked files are listed but excluded
- `npm whoami`
- `npm owner ls appback-remoteagent`
- `npm run check`
- `npm run build`
- `npm pack`
- guarded `npm publish`
- exact published version and `latest` dist-tag verification

The package publish entrypoint is `npm run release:publish`.
`scripts/prepublish-guard.mjs` routes manual publish attempts back to that entrypoint.

## 5. Deploy Published Version

Deploy to server 30:

```bash
npm run release:deploy -- <version> 30
```

Deploy to server 40:

```bash
npm run release:deploy -- <version> 40
```

Deploy to server 26:

```bash
npm run release:deploy -- <version> 26
```

Deploy to both production targets:

```bash
npm run release:deploy -- <version> all
```

Example:

```bash
npm run release:deploy -- 0.15.5 all
```

The deploy script performs:

- npm registry version check for `appback-remoteagent@<version>`
- server 30 npm install, install hook, systemd restart, version/log verification
- server 40 npm install, install hook, user-process restart, version/log verification
- server 26 npm install, install hook, user-process restart, version/log verification

## 6. Verify

Registry:

```bash
npm view appback-remoteagent version
```

Server 30:

```bash
ssh au2223@192.168.33.30 'bash -lc '"'"'
export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"
systemctl is-active remoteagent
node -p "require(\"/home/au2223/.nvm/versions/node/v22.22.0/lib/node_modules/appback-remoteagent/package.json\").version"
journalctl -u remoteagent --since "5 minutes ago" --no-pager | tail -80
'"'"''
```

Server 26:

```bash
ssh ospadmin@192.168.33.26 'bash -lc '"'"'
npm list -g appback-remoteagent --depth=0
pgrep -af "appback-remoteagent/dist/index.js"
tail -80 ~/.remoteagent/logs/agent.log
'"'"''
```

Server 40:

```bash
ssh appback@192.168.33.40 'bash -lc '"'"'
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm list -g appback-remoteagent --depth=0
pgrep -af "appback-remoteagent/dist/index.js"
tail -80 ~/.remoteagent/logs/agent.log
'"'"''
```

## Release 0.15.5

Date: 2026-07-08

Changes:

- Telegram file attachment download now writes to `.part` first.
- Telegram file attachment download resumes partial files with `curl -C -`.
- Telegram file attachment download retries up to 4 attempts.
- Download timeout changed from one 60-second attempt to resumable 120-second attempts.
- npm publish flow is guarded by `prepublishOnly`.
- Standard publish command is `npm run release:publish`.
- Standard deploy command is `npm run release:deploy -- <version> <30|26|all>`.

Validated:

```bash
npm run check
npm run build
npm run release:publish
npm run release:deploy -- 0.15.5 all
```

Published:

```text
appback-remoteagent@0.15.5
```

Runtime targets:

```text
server 30: 0.15.5 active
server 26: 0.15.5 running
```

## Release 0.17.0

Date: 2026-07-29

Changes:

- Queued instructions receive runtime-unique `Q001`-style ids.
- `/queue` lists instructions waiting behind the current session work.
- `/queue remove <id>` removes one selected waiting instruction.
- `/queue del` removes the most recently queued instruction.
- `/stop` reports and clears queued work-loop instructions as well as pending message batches.
- Telegram startup preserves the configured bot username when `getMe` temporarily fails, preventing existing chat/session bindings from being bypassed by a generated numeric bot identity.

Validated:

```bash
npm run check
npm run build
npm run selftest:telegram
npm run release:publish
npm run release:deploy -- 0.17.0 all
```

## Release 0.17.1

Date: 2026-08-03

Changes:

- Codex JSON stdout is parsed while the provider process is running.
- `REPORT:progress` messages are delivered to Telegram immediately without starting another provider turn.
- A streamed final progress message is deduplicated from the normal post-process response path.
- Queue instructions are announced in one Telegram message instead of two.
- Queue notices include inline `/queue remove Qxxx` and `/queue del` buttons that execute the existing queue removal behavior.

Validated:

```bash
npm run check
npm run build
npm run selftest:codex-stream
npm run selftest:telegram
npm run release:publish
npm run release:deploy -- 0.17.1 30
```

## Release 0.18.0

Date: 2026-08-03

Changes:

- Telegram list and option responses provide inline command controls.
- Queue notices provide inline remove-latest and remove-by-id controls in one message.
- Codex progress streaming accepts both normalized CLI `item.completed` events and raw `event_msg`/`response_item` agent-message events.
- The Codex stream self-test covers every supported progress event shape and keeps final results out of the progress callback.

Validated:

```bash
npm run check
npm run build
npm run selftest:codex-stream
npm run selftest:telegram
npm run release:publish
npm run release:deploy -- 0.18.0 30
```
