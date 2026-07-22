# Operations

## Source of truth

RemoteAgent production is operated from one canonical Git history:

- source of truth: `origin/main` on GitHub
- production runtime host: server 30
- production package: `appback-remoteagent`
- branch used for production releases: `main`

Use `origin/main` as the authoritative source.
Code changes should be committed and pushed to `origin/main`, published to npm, and then server 30/26 should be updated from that npm version.
Production release commands are:

```bash
npm run release:publish
npm run release:deploy -- <version> all
```

Local tarball installation is an emergency runtime restoration path.
The production release is completed by publishing the same version to npm and running `npm run release:deploy -- <version> all`.

## Product shape in operations

Operationally, RemoteAgent is a self-hosted runtime with multiple client surfaces.

Current and planned client layers:

- Telegram bot chat: primary production client
- Telegram Mini App: planned richer control UI
- local terminal / shell: operator maintenance path

The runtime server is always the execution engine.
Neither Telegram chat nor the Mini App is the source of truth for sessions.

## Current bot split

Current production bot ownership is intentionally split:

- server 30: RemoteAgent production bots
- local machine 21: local-only bot runtime

Assign each Telegram bot token to one runtime at a time.
Bot polling conflicts are treated as incidents, not harmless warnings.

When a runtime has several configured Telegram bots, polling pressure can become operationally visible.
RemoteAgent reduces that pressure with rank-based polling intervals instead of deep sleep or a special main bot.
See [BOT_POLLING_POLICY.md](./BOT_POLLING_POLICY.md).

## Workspace policy

Default fresh sessions should not use a broad parent folder like `/home/au2223/projects` as their direct working directory.

Current policy:

- `DEFAULT_WORKSPACE` is a fallback path for explicit attaches and compatibility
- `WORKSPACE_ROOT` is the root for runtime-managed fresh session workspaces
- fresh `/start` and `/new` sessions without an explicit path create a new subdirectory under `WORKSPACE_ROOT`
- the managed subdirectory name is a random 8-character uid
- display ids like `S001` remain user-facing session labels only and are not reused as folder names

## Runtime model

Server 30 runs RemoteAgent as a `systemd` service.

- unit: `remoteagent.service`
- working directory: the installed `appback-remoteagent` package root
- runtime data: `/home/au2223/.remoteagent`
- service entrypoint: `remoteagent` or `node <installed-package-root>/dist/index.js`

The service environment is loaded from:

- `/home/au2223/.remoteagent/.env`

## Single-instance rule

A previous failure mode was mixed lifecycle control:

- manual `./scripts/start.sh`
- existing `systemd` service
- stale PID files
- multiple `node dist/index.js` processes

That caused old and new builds to overlap and made Telegram image handling look random.

Current protections:

1. `systemd` is the primary runtime owner.
2. `scripts/start.sh` and `scripts/stop.sh` prefer `systemd` when the service exists.
3. the app creates a lock file at `/home/au2223/.remoteagent/remoteagent.lock`.
4. a second `node dist/index.js` process exits immediately instead of starting a duplicate runtime.
5. per-session message handling is serialized inside `BridgeService`.

## Day-to-day commands

Check service status:

```bash
sudo systemctl status remoteagent
```

Watch logs:

```bash
journalctl -u remoteagent -f
```

Restart after build:

```bash
export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"
npm install -g appback-remoteagent@<version>
remoteagent-install
sudo systemctl restart remoteagent
node -p 'require("/home/au2223/.nvm/versions/node/v22.22.0/lib/node_modules/appback-remoteagent/package.json").version'
```

Check the lock owner:

```bash
cat /home/au2223/.remoteagent/remoteagent.lock
```

## Disk maintenance

RemoteAgent disk growth usually comes from Docker build cache, Docker volumes, Codex session logs, managed workspaces, Telegram uploads, and temporary build artifacts.

Use one script for repeatable checks and conservative cleanup:

```bash
npm run maintenance:disk -- report
```

Run the safe cleanup path:

```bash
npm run maintenance:disk -- prune-safe
```

`prune-safe` performs only these actions:

- `docker builder prune -f`
- remove old `/tmp/remoteagent-codex-*`, `/tmp/remoteagent-claude-*`, and `/tmp/appback-*` directories older than 2 days
- remove managed workspace directories under `WORKSPACE_ROOT` only when they are not referenced by RemoteAgent `state.json`

Clean only orphan managed workspaces:

```bash
npm run maintenance:disk -- prune-workspaces
```

RemoteAgent also runs conservative workspace cleanup on a schedule when enabled:

```bash
WORKSPACE_CLEANUP_ENABLED=true
WORKSPACE_CLEANUP_INTERVAL_MS=86400000
```

Scheduled workspace cleanup only removes managed workspace directories under `WORKSPACE_ROOT` when they are not referenced by RemoteAgent `state.json`.
If `state.json` is missing or invalid, workspace cleanup refuses to run.

Clean the current chat session workspace manually from Telegram:

```text
/cleanup
```

`/cleanup` does not delete the session workspace directory itself. It removes the contents of the current managed workspace while preserving RemoteAgent's session todo/state/history under `~/.remoteagent/managed/sessions/<session>`. If a top-level `TODO.md`, `todo.md`, or `todo.json` exists inside the workspace, it is also preserved. The command refuses non-RemoteAgent-managed workspaces.

Archive old Codex session logs explicitly:

```bash
npm run maintenance:disk -- prune-codex-sessions 45
```

This creates an archive under `~/.codex/session-archive/` and removes the archived jsonl files from `~/.codex/sessions`.
Use this only when old Codex resume history is no longer needed.

For server 30, run the installed package script through npm:

```bash
ssh au2223@192.168.0.30 'export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"; npm explore -g appback-remoteagent -- npm run maintenance:disk -- report'
ssh au2223@192.168.0.30 'export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"; npm explore -g appback-remoteagent -- npm run maintenance:disk -- prune-safe'
```

For server 26:

```bash
ssh ospadmin@192.168.0.26 'export PATH="$HOME/.local/bin:$PATH"; npm explore -g appback-remoteagent -- npm run maintenance:disk -- report'
ssh ospadmin@192.168.0.26 'export PATH="$HOME/.local/bin:$PATH"; npm explore -g appback-remoteagent -- npm run maintenance:disk -- prune-safe'
```

## Git workflow

The intended workflow is:

1. edit in the active development checkout
2. choose `patch`, `minor`, or `major` for the current deployment
3. bump the package version before deployment
4. run `npm run check`
5. run `npm run build`
6. commit on `main`
7. push `main` to `origin/main`
8. publish `appback-remoteagent@<version>` to npm
9. install that exact npm version on server 30 and server 26
10. restart `remoteagent.service` when runtime code changed
11. verify logs or a Telegram/local UI path on each target

Avoid side branches and extra worktrees unless there is a strong reason.
If a temporary branch is unavoidable, merge it back to `main`, push it, and deploy from `origin/main`.

A task is not done until commit and push both happened.
A production deployment is not done until server 30 and server 26 are running the published npm version and the runtime path has been verified.
If npm publish returns `403`, use a publish-capable npm token for the unscoped `appback-remoteagent` package and run:

```bash
source ~/.config/remoteagent/npm-token.env
npm run release:publish
```

See `docs/RELEASING.md`.

See `docs/RELEASING.md` for the detailed versioning rules.

## GitHub authentication

Server 30 is configured to push as `appback`.

Validation commands:

```bash
gh auth status -h github.com
ssh -T git@github.com
```

At the time of writing, `origin/main` pushes are performed successfully from server 30.

## Mini App operational rule

A Telegram Mini App must be treated as another client surface for the same runtime.

That means:

- it must read and act on the same session model
- it must not invent a second session store
- it must not bypass runtime authorization or ownership checks
- it should prefer structured actions that map cleanly onto existing runtime commands and APIs

## Attachment handling status

As of the latest stabilization work:

- Telegram image download works
- files are saved under `/home/au2223/.remoteagent/uploads/telegram/...`
- duplicate runtime startup has been blocked
- RemoteAgent-mediated file sending uses `TELEGRAM_FILE: /absolute/path/to/file`
- RemoteAgent sends conversation replies and `TELEGRAM_FILE` attachments only to the current incoming bot and chat
- product/service Telegram notifications are not RemoteAgent conversation delivery; they belong in that project's code and should use that project's secret/config path

Remaining work is still needed on attachment response policy and richer file UX.
The transport/runtime stability issue and the user-facing attachment response quality issue are separate concerns.

## Incident summary

The main production problem around April and May 2026 was not just attachment support itself.
The deeper issues were runtime ownership and transport discipline:

- old processes survived restarts
- service-managed and manually-started processes overlapped
- PID state and actual live processes diverged
- Telegram responses could come from an unexpected process generation
- RemoteAgent conversation delivery needed a single current incoming bot/chat owner

The single-instance lock, `systemd`-first lifecycle, and runtime-owned conversation delivery rules were added specifically to stop that class of bug from recurring.
