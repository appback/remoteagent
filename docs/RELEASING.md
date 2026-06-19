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
7. Publish `appback-remoteagent@<version>` to npm
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
npm publish
```

Typical target deployment sequence for server 30 and server 26:

```bash
VERSION=0.13.0
npm install -g appback-remoteagent@$VERSION
remoteagent-install
sudo systemctl restart remoteagent
systemctl is-active remoteagent
journalctl -u remoteagent --since "2 minutes ago" --no-pager
```

## Other Runtime Follow-up

Server 30 and server 26 are production runtime targets.
Machine 21 or any other host should be updated only when it intentionally runs a separate RemoteAgent service.

At minimum, the operator should run the install/update flow again and verify the process comes back up cleanly.
For npm installs, the package contains `dist/`, so the target machine should not need a repository checkout or a separate manual build step.
