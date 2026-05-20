# Operations

## Source of truth

RemoteAgent is currently operated from one canonical checkout only:

- host: server 30
- repo path: `/home/au2223/projects/remoteagent`
- branch used for production changes: `main`

Do not use local WSL worktrees or duplicate checkouts as an editing source for this project.
If code must change, change it in the server 30 checkout, build it there, and push from there.

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
- working directory: `/home/au2223/projects/remoteagent`
- runtime data: `/home/au2223/.remoteagent`
- service entrypoint: `/home/au2223/.local/bin/node /home/au2223/projects/remoteagent/dist/index.js`

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
cd /home/au2223/projects/remoteagent
/home/au2223/.local/bin/npm run build
sudo systemctl restart remoteagent
```

Check the lock owner:

```bash
cat /home/au2223/.remoteagent/remoteagent.lock
```

## Git workflow

The intended workflow is:

1. edit on server 30
2. choose `patch`, `minor`, or `major` for the current deployment
3. bump the package version before deployment
4. run `npm run check`
5. run `npm run build`
6. restart `remoteagent.service` when runtime code changed
7. verify logs or a Telegram/local UI path
8. commit on `main`
9. push `main` to `origin/main`
10. update machine 21's npm-installed RemoteAgent runtime when the runtime package changed

Avoid side branches and extra worktrees unless there is a strong reason.
If a temporary branch is unavoidable, merge it back on server 30 and return production work to `main` immediately.

A task is not done until commit and push both happened.
A deployment is not done until machine 21 has also been updated when the package/runtime changed.

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
