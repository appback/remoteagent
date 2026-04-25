# Operations

## Source of truth

RemoteAgent is currently operated from one canonical checkout only:

- host: server 30
- repo path: `/home/au2223/projects/remoteagent`
- branch used for production changes: `main`

Do not use local WSL worktrees or duplicate checkouts as an editing source for this project.
If code must change, change it in the server 30 checkout, build it there, and push from there.

## Current bot split

Current production bot ownership is intentionally split:

- server 30: `codex_remoteagent_bot`
- local machine 21: `sqream_bot`

Server 30 should not run `sqream_bot`.
Local machine 21 should not run `codex_remoteagent_bot`.

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
2. run `npm run check`
3. run `npm run build`
4. restart `remoteagent.service`
5. verify logs or a Telegram/local UI path
6. commit on `main`
7. push `main` to `origin/main`

Avoid side branches and extra worktrees unless there is a strong reason.
If a temporary branch is unavoidable, merge it back on server 30 and return production work to `main` immediately.

## GitHub authentication

Server 30 is configured to push as `appback`.

Validation commands:

```bash
gh auth status -h github.com
ssh -T git@github.com
```

At the time of writing, `origin/main` pushes are performed successfully from server 30.

## Attachment handling status

As of the latest stabilization work:

- Telegram image download on server 30 works
- files are saved under `/home/au2223/.remoteagent/uploads/telegram/...`
- duplicate runtime startup has been blocked
- image sends no longer rely on mixed old/new processes

Remaining work is still needed on attachment response policy.
The transport/runtime stability issue and the user-facing attachment response quality issue are now separate concerns.

## Incident summary

The main production problem around April 2026 was not just image support itself.
The deeper issue was runtime ownership:

- old processes survived restarts
- service-managed and manually-started processes overlapped
- PID state and actual live processes diverged
- Telegram responses could come from an unexpected process generation

The single-instance lock and `systemd`-first lifecycle were added specifically to stop that class of bug from recurring.
