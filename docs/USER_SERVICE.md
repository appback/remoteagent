# User Service Operations

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
