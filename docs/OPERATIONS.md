# Operations

## Source of truth

RemoteAgent production is operated from one canonical Git history:

- source of truth: `origin/main` on GitHub
- production runtime host: server 30
- production package: `appback-remoteagent`
- branch used for production releases: `main`

Do not treat stale server paths or duplicate worktrees as authoritative.
Code changes should be committed and pushed to `origin/main`, published to npm, and then server 30/26 should be updated from that npm version.

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

Do not run the same Telegram bot token from multiple runtimes at the same time.
Bot polling conflicts are treated as incidents, not harmless warnings.

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
sudo npm install -g appback-remoteagent@<version>
sudo systemctl restart remoteagent
```

Check the lock owner:

```bash
cat /home/au2223/.remoteagent/remoteagent.lock
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
- cross-bot direct Telegram token leakage to provider subprocesses has been blocked
- official runtime-mediated file sending is available only through confirmed RemoteAgent transfer paths

Remaining work is still needed on attachment response policy and richer file UX.
The transport/runtime stability issue and the user-facing attachment response quality issue are separate concerns.

## Incident summary

The main production problem around April and May 2026 was not just attachment support itself.
The deeper issues were runtime ownership and transport discipline:

- old processes survived restarts
- service-managed and manually-started processes overlapped
- PID state and actual live processes diverged
- Telegram responses could come from an unexpected process generation
- provider subprocesses had to be prevented from directly using Telegram bot tokens

The single-instance lock, `systemd`-first lifecycle, and runtime-mediated file transfer rules were added specifically to stop that class of bug from recurring.
