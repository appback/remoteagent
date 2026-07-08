# Releasing

## Versioning rule

RemoteAgent uses semantic versioning for every production deployment:

- `MAJOR`: breaking command changes, storage/runtime contract changes, or migrations that can break an existing installation
- `MINOR`: new user-facing capabilities, new commands, new adapters, or non-breaking workflow expansion
- `PATCH`: bug fixes, reliability improvements, security fixes, text-only corrections, and non-breaking maintenance

Do not deploy production changes without bumping the package version first.

## Decision guide

Use `PATCH` when the behavior is supposed to stay the same but gets safer or more correct.
Use `MINOR` when the owner can do something new after the release without needing migration.
Use `MAJOR` when an older installation, script, or user workflow would need active adjustment.

When unsure between two levels, choose the higher one and explain why in the commit message.

## Required release flow

A release is only considered complete when all of the following are done in order:

1. Choose the release scope: `patch`, `minor`, or `major`
2. Bump the version in `package.json` and `package-lock.json`
3. Run `npm run check`
4. Run `npm run build`
5. Commit the completed work
6. Push `main` to `origin/main`
7. Publish `appback-remoteagent@<version>` to npm using a token/account that is proven to have publish rights for this unscoped package
8. Install that exact npm version on server 30 and server 26
9. Restart `remoteagent.service` on each target if runtime code changed
10. Verify the relevant runtime path, logs, or Telegram behavior on each target

If commit or push is missing, the work is not done.
If server 30 or server 26 is not running the published npm version, the production deployment is incomplete.

## Commands

Version bump helpers:

```bash
./scripts/bump-version.sh patch
./scripts/bump-version.sh minor
./scripts/bump-version.sh major
```

Equivalent npm shortcuts:

```bash
npm run version:patch
npm run version:minor
npm run version:major
```

Typical local release sequence:

```bash
./scripts/bump-version.sh patch
npm run check
npm run build
git status
git add -A
git commit -m "Release 0.12.3"
git push origin main
npm pack
```

## npm publish procedure

Use this package-specific path for `appback-remoteagent`.

Direct `npm publish` is blocked by `prepublishOnly`.
The only normal publish command is:

```bash
npm run release:publish
```

Do not publish this package with the machine 21 `21token`.
That token can authenticate as `appbackhub`, but it does not currently have publish rights for the unscoped `appback-remoteagent` package.
It fails at publish time with:

```text
403 Forbidden - You may not perform that action with these credentials.
```

Before publishing, always verify both identity and package ownership:

```bash
npm whoami
npm owner ls appback-remoteagent
```

Authentication alone is not enough.
If `npm whoami` works but `npm publish` returns `403`, stop and get a publish-capable npm token instead of retrying with the same token.

The guarded registry publish path is:

```bash
npm run release:publish
npm view appback-remoteagent version
```

If registry caching briefly returns the previous version after publish, wait a few seconds and rerun `npm view appback-remoteagent version` before installing to servers.

## Emergency tarball install

An emergency tarball install is allowed only to restore a broken runtime when npm publish is blocked.
It is not a completed release and must be reported as a temporary hotfix.

Rules:

- do not call it "npm deployed" or "released"
- do not delete runtime state
- do not use source checkout deployment
- confirm no active provider process is running before restart
- install the exact local package tarball with `npm install -g /tmp/appback-remoteagent-<version>.tgz`
- follow up by publishing the same version to npm once a publish-capable token is available

Emergency server 30 flow:

```bash
VERSION=0.14.0
npm pack
scp appback-remoteagent-$VERSION.tgz au2223@192.168.0.30:/tmp/
ssh au2223@192.168.0.30 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"
pgrep -af 'codex|claude' || true
npm install -g "/tmp/appback-remoteagent-$VERSION.tgz"
remoteagent-install
sudo -n systemctl restart remoteagent
systemctl is-active remoteagent
node -p 'require("/home/au2223/.nvm/versions/node/v22.22.0/lib/node_modules/appback-remoteagent/package.json").version'
journalctl -u remoteagent --since '2 minutes ago' --no-pager
REMOTE
rm -f appback-remoteagent-$VERSION.tgz
```

## Target deployment sequence

Server 30 uses a systemd service:

```bash
VERSION=0.14.0
ssh au2223@192.168.0.30 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
export PATH="/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH"
npm install -g appback-remoteagent@$VERSION
/home/au2223/.nvm/versions/node/v22.22.0/bin/remoteagent-install
sudo -n systemctl restart remoteagent
systemctl is-active remoteagent
node -p 'require("/home/au2223/.nvm/versions/node/v22.22.0/lib/node_modules/appback-remoteagent/package.json").version'
journalctl -u remoteagent --since '2 minutes ago' --no-pager
REMOTE
```

Do not run `sudo npm install -g` on server 30. The global RemoteAgent package is installed under
`/home/au2223/.nvm/versions/node/v22.22.0`; only the `systemctl restart remoteagent` step needs sudo.
Runtime state remains in `/home/au2223/.remoteagent` and must not be deleted during npm upgrades.

Server 26 currently uses user-level start/stop scripts, not a systemd `remoteagent.service`:

```bash
VERSION=0.14.0
ssh ospadmin@192.168.0.26 "VERSION=$VERSION bash -s" <<'REMOTE'
set -euo pipefail
npm install -g appback-remoteagent@$VERSION
remoteagent-install
~/.remoteagent/stop-remoteagent.sh || true
sleep 2
~/.remoteagent/start-remoteagent.sh
sleep 3
pgrep -af "appback-remoteagent/dist/index.js"
tail -80 ~/.remoteagent/logs/agent.log
REMOTE
```

## Other Runtime Follow-up

Server 30 and server 26 are production runtime targets.
Machine 21 or any other host should be updated only when it intentionally runs a separate RemoteAgent service.

At minimum, the operator should run the install/update flow again and verify the process comes back up cleanly.
For npm installs, the package contains `dist/`, so the target machine should not need a repository checkout or a separate manual build step.
