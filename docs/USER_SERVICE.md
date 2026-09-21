# User Service Operations

## Telegram Self-Update

Send `/version` (shortcut `/v`) to see the currently running RemoteAgent version.
Send `/install` to choose RemoteAgent, Codex or Claude with buttons. Direct
commands such as `/install remoteagent` and `/install codex` remain supported.
The menu itself starts no installation; selecting a button runs the same
owner-authorized operation as the corresponding direct command.

Send `/install remoteagent` to check npm latest and update an idle user-service
installation. A separate user-systemd worker stages both current/new npm packages,
stops the runtime, installs the new package, starts it, and checks service health.
Failure after stopping triggers reinstall of the staged previous version.
Configuration and sessions are retained; no OS restart or automatic migration is
performed. Requires a global npm installation writable by the service account.

Existing work causes refusal. While an update is pending, new requests are
explicitly rejected (not silently queued); `/help`, `/status`, `/stop` remain
available until the short runtime restart. Resend other requests after completion.
Duplicate update requests are locked by `~/.remoteagent/self-update.json`.
After an interrupted worker, inspect `journalctl --user -u 'remoteagent-update-*'`
before clearing that pending file. Results are also stored in
`~/.remoteagent/self-update-result.json` if Telegram delivery fails.

Shell example: `/! ip addr | grep "inet"`.

## Server 110 Deployment

```sh
npm run release:deploy -- 0.23.8 110
```

Target: `appback@192.168.33.110`, Node `v22.23.2`. This target checks
active jobs and Codex processes, backs up configuration/state, installs the exact
npm version, enables linger, and migrates an existing system service. Later runs
restart the user service. Noninteractive sudo is required for initial migration
and linger configuration. `all` retains its existing 30/40/26 scope.

RemoteAgent runs as the same OS account that owns Codex, credentials, secrets,
and projects. New non-root Linux installations register and enable
`~/.config/systemd/user/remoteagent.service` when a user service manager is
available. Installation does not start the bot before configuration is ready.

```sh
remoteagent-install
remoteagent bot add
remoteagent-start
systemctl --user status remoteagent
```

If the manager is unavailable, sign in via SSH as that account and run:

```sh
remoteagent service install
remoteagent-start
```

For automatic startup at boot and persistence after logout, an administrator
may need to enable linger once (example for server 40):

```sh
sudo loginctl enable-linger appback
loginctl show-user appback -p Linger
```

## Migrate Existing System Service

Update the npm package first, then run these commands as the existing runtime
account, after provider work finishes:

```sh
remoteagent service migrate
systemctl --user is-active remoteagent
systemctl is-active remoteagent
systemctl is-enabled remoteagent
```

Migration checks active-work markers, writes the user unit, stops and disables
the old system unit using sudo, then starts and checks the user unit. This
one-time administrative operation may prompt in the terminal. On failure it
stops the new unit, restores the previous unit file, and attempts to restore
the original system service enable/running state. If sudo recovery fails,
inspect both service scopes before starting either one.

The data directory, secrets, sessions, and workspace files are reused without
copying or resetting. Existing plain-process runtimes must first be stopped
with `remoteagent-stop`. An installer update retains existing system services;
migration is explicit, never silently triggered during npm updates.

## Restart and Diagnostics

```sh
systemctl --user restart remoteagent
remoteagent-stop
remoteagent-start
journalctl --user -u remoteagent --since '10 minutes ago'
tail -n 80 ~/.remoteagent/logs/agent.log
```

Bot mutations validate the restart path before editing configuration. User
services schedule a separate `systemd-run --user` job so stopping RemoteAgent
does not kill its restart helper. System-service permission failures are
reported immediately rather than falling through to an unprivileged helper.
Runtime restart failures restore the configuration and attempt Telegram failure
notification immediately; undelivered notices remain pending for recovery.

`SUDO_PASSWORD` is not required for normal user-service operation.

Local regression validation:

```sh
npm run build
node scripts/selftest-user-service.mjs
node scripts/selftest-login.mjs
node scripts/selftest-telegram-update.mjs
```
