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

After npm has accepted an upload but registry processing is still pending, run
only verification (no new upload, build, authentication change or version bump):

```bash
npm run release:publish -- --verify-only
```

The verification window is bounded to 36 checks with five-second waits plus npm
request time. A pending registry response after upload acceptance is not evidence
that the npm credential failed.

The publish script performs:

- tracked working tree check
- a clean staging snapshot from committed `HEAD`; unrelated untracked files are listed but excluded
- `npm whoami`
- `npm owner ls appback-remoteagent`
- `npm run check`
- `npm run build`
- `npm pack`
- guarded `npm publish`
- provider installation regression tests in the clean staging snapshot before publishing
- dot protocol tests and Telegram command/button injection tests in that same snapshot
- exact published version and `latest` dist-tag verification with bounded propagation retries

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
- bounded retry when a target server's npm registry edge has not received the new version yet
- fail-fast validation for a broken or non-directory `~/.npm` cache path before remote installation
- server 30 npm install, install hook, systemd restart, version/log verification
- server 40 npm install, install hook, systemd restart using `SUDO_APPBACK_33_40`, version/log verification
- server 26 npm install, install hook, user-process restart, version/log verification

## 6. Verify

### macOS server 60

```bash
npm run release:deploy -- 0.26.1 60
```

The script refuses active non-transport child processes or running-session metadata,
backs up the runtime configuration, installs the exact npm version and switches the
existing RemoteAgent LaunchAgent to the npm entrypoint. It preserves session data
and other services, verifies the live process path and attempts rollback on error.
After independently confirming stale running metadata and no live provider work:

```bash
ALLOW_STALE_RUNNING=1 ACTIVATE_JEV=1 npm run release:deploy -- 0.26.1 60
```

ACTIVATE_JEV requires an existing server-side key and enables review routing; no key
value is printed or copied. Without it, the current Jev mode is preserved. The stale
override does not skip the live process check. Inspect returned reports and Jev
decision logs after deployment; a healthy process alone does not prove review quality.

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
systemctl is-enabled remoteagent
systemctl is-active remoteagent
systemctl show remoteagent -p MainPID -p NRestarts
systemctl status remoteagent --no-pager -n 20
tail -80 ~/.remoteagent/logs/agent.log
'"'"''
```

## Release 0.27.2 (2026-10-22)

- Makes the managed macOS installer accept tunnel credentials generated beside
  an explicit Cloudflare certificate, as well as the default `.cloudflared`
  location. It validates the tunnel UUID and stages the matching credential in
  the private transport directory. Reruns retain an already running binary.
- Four portable credential-location/identity/permissions regression tests added
  to the canonical clean-snapshot publish gate.

## Release 0.27.1 (2026-10-22)

- Replaces the external-IdP assumption with managed owner OAuth using pinned
  `oidc-provider` 9.12.2. Existing external OAuth remains supported explicitly.
- `/login dot` supplies a five-minute one-use owner approval code in private chat.
  Actual PKCE, token refresh, restart, revocation, cookie/origin/CSRF and code-replay
  tests run against the real OAuth library, not a mocked token exchanger.
- Adds `remoteagent dot setup` for a dedicated macOS Cloudflare tunnel and user
  LaunchAgent. Exact parameter examples are in `docs/DOT_BRIDGE.md`. Activation
  checks provider work before changing configuration and preserves existing
  application tunnels, sessions and the private local UI.
- Managed callbacks enforce public-address validation, pinned TLS and challenge
  verification without requiring a guessed callback-host setting.
- Published from `4cc497c`, with exact npm version and `latest` verified at check
  28. Tarball SHA1: `8f1f44c5f98cb32310869fa2f34769aee075303c`.
- 60 deployment completed via `npm run release:deploy -- 0.27.1 60` with no active
  provider work. Backup: `/Users/appback/.remoteagent/backups/npm-0.27.1-20261022T203736`.
- Dedicated tunnel `3de791c1-06d8-4ef9-bffd-a673945d3a69` and hostname
  `remoteagent-dot60.appback.app` created. The initial CLI attempt stopped before
  DNS/runtime changes because cloudflared wrote its credential next to the
  explicit certificate. The credential was migrated privately to the default
  location and setup/activation then succeeded; 0.27.2 fixes the installer path.
- Actual public checks: protected-resource metadata 200; OIDC metadata 200 with
  PKCE S256 and CIMD; unauthenticated MCP 401; `/api/sessions` and root both 404.
  Authorization using the real ChatGPT CIMD document returned 303, and the owner
  approval page returned 200 with its code form and CSRF field.
- This verifies transport and the real client metadata/authorization entry path,
  not a user's completed ChatGPT plugin link or a cloud dot Telegram round trip.

## Release 0.27.0 (2026-10-22)

- Adds the optional, default-off dot MCP Events bridge.
- `/login dot` prepares a channel without changing current work and provides the
  configured MCP endpoint, plugin registration link, copyable dot subscription
  instruction and verify/start buttons.
- `/start dot` requires a verified subscription. Explicit local-provider starts
  suspend dot routing while preserving its subscription for later reuse.
- Dot protocol tests cover signing, callback address/deadline validation,
  authentication, bounded retries, cancellation, disk failure and restart.
- The clean-snapshot publish gate now includes dot and Telegram injection tests.
- Local tests do not constitute live dot account acceptance. Server authentication,
  endpoint setup and a real account round trip remain separate deployment checks.
- Published from source `606f99d` using `npm run release:publish`; clean-snapshot
  provider installation, 19 dot protocol tests, Telegram command/button injection,
  session dispatch and upload tests passed before the upload.
- npm accepted the upload, then registry processing exceeded the old 12-check
  window. No credentials were changed and the package was not republished.
- `npm run release:publish -- --verify-only` confirmed both exact version and
  `latest` as `0.27.0` on check 12 of the extended window.
- Package tarball SHA1: `e67237ba1e3a7972f5e91df14a712b231a85f64b`.
- User-selected rollout completed on 30, 40 and 60 using these exact commands:

  ```bash
  npm run release:deploy -- 0.27.0 30
  npm run release:deploy -- 0.27.0 40
  ALLOW_STALE_RUNNING=1 npm run release:deploy -- 0.27.0 60
  ```

- 30: system service active/running, PID 1199865, npm runtime version 0.27.0.
  Startup reported seven bot credentials as Unauthorized; ten other bots reached
  ready state. No bot credentials, registrations or sessions were removed.
- 40: user service active/running, PID 3437602, npm runtime version 0.27.0.
  Its old system unit is disabled/inactive. The original deployment command
  exited at the final system-unit status check after successful installation and
  user-service restart. Independent user-service checks confirmed success.
  The repository deployment script now verifies the selected user unit first.
- 60: LaunchAgent running, PID 33549, npm runtime version 0.27.0. Initial preflight
  stopped before changes because polling metadata still marked S009 as running.
  Read-only inspection found no Codex process or non-transport runtime children,
  and S009 events recorded a final result at 2026-10-22T02:36:43.691Z. Only after
  these checks was the documented stale-state override used; preflight checked
  process descendants again. No provider process was terminated.
- 60 backup: `/Users/appback/.remoteagent/backups/npm-0.27.0-20261022T194358`.
- All three local session-list endpoints returned HTTP 200 after rollout.
  `DOT_ENABLED` remains unset/default-off on all three; real dot authentication,
  plugin registration and a Telegram round trip are not yet verified.
- The follow-up repository release-script change adds `--verify-only` and a
  36-check window. It is not retroactively included in the immutable npm tarball.

## Release 0.26.3 (2026-10-14)

- Source f6a47c0; session dispatch implementation ef6f97f.
- Published through release:publish. npm processing exceeded the initial propagation
  window; later exact version and latest checks both returned 0.26.3.
- Deployed with npm run release:deploy -- 0.26.3 60 after verifying no active provider
  children or running-session metadata. Installed npm path and one LaunchAgent runtime
  verified (PID 93437). Existing seven sessions preserved.
- Backup: /Users/appback/.remoteagent/backups/npm-0.26.3-20261014T230321.
- Live checks: unauthenticated dispatch API 401; missing target SESSION_NOT_FOUND;
  installed helper lists S003/S007. Actual helper invocation with source S003 sent a
  read-only textual deployment probe to S007 and received its final report.
- Receipt ffd7c33d-b484-46fd-8152-5df426219362: reported, receiver output
  "RemoteAgent 세션 전달 검증 완료." Final receiver Telegram send returned successfully.
  This checks the receiver/report-return path, not a subsequent S003 model decision.
- Jev mode was off at pre/post deployment configuration inspection and was preserved.
  Jev-on continuation and correction are covered by the mock regression suite.
- No other server was updated; the probe did not request repository or application changes.

## Release 0.26.2 (2026-10-13)

- Source: main 36680d6 (Jev changes d607a88 plus macOS runtime ownership guard).
- Published through release:publish. npm initially accepted the upload but returned
  404 during processing, exceeding the script's propagation window. Subsequent exact
  version and latest checks both returned 0.26.2; no source deployment was substituted.
- Target: 192.168.33.60 only. Inspected stale running metadata from October 10 and
  confirmed no provider child process before using the explicit stale-state override.
- Applied: ALLOW_STALE_RUNNING=1 ACTIVATE_JEV=1 npm run release:deploy -- 0.26.2 60.
- Replaced independently launched old runtime with the existing user LaunchAgent,
  pointing at /Users/appback/.local/lib/node_modules/appback-remoteagent/dist/index.js.
- Verified one runtime (PID 72597), package 0.26.2, seven session records preserved.
- Jev: on, threshold 0.7, correction retries 2. Real review API returned available=true,
  action=retry for an unperformed-work promise. This confirms connectivity and that
  sample's decision, not general classification accuracy or a Telegram end-to-end test.
- Backup: /Users/appback/.remoteagent/backups/npm-0.26.2-20261013T145910.
- No other server or application service was restarted.

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
