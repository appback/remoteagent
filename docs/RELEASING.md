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
7. Update server 30's production app path to the pushed commit
8. Run `/home/au2223/.local/bin/npm ci` and `/home/au2223/.local/bin/npm run build` on server 30
9. Restart `remoteagent.service` on server 30 if runtime code changed
10. Verify the relevant runtime path, logs, or Telegram behavior
11. Update any other installed RemoteAgent runtime when that machine intentionally runs one

If commit or push is missing, the work is not done.
If server 30 is not running the pushed version, the production deployment is incomplete.

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
```

Typical server 30 deployment sequence:

```bash
APP=/home/au2223/.remoteagent/app/remoteagent-src
cd "$APP"
git fetch origin main
git reset --hard origin/main
git clean -fd -e node_modules
export PATH=/home/au2223/.local/bin:/home/au2223/.nvm/versions/node/v22.22.0/bin:$PATH
npm ci
npm run build
sudo systemctl restart remoteagent
systemctl is-active remoteagent
journalctl -u remoteagent --since "2 minutes ago" --no-pager
```

## Other Runtime Follow-up

Server 30 is the production runtime.
Machine 21 or any other host should be updated only when it intentionally runs a separate RemoteAgent service.

At minimum, the operator should run the install/update flow again and verify the process comes back up cleanly.
For GitHub-based installs, the package builds `dist/` during `prepare`, so a clean reinstall should produce a runnable package without a separate manual build step.
