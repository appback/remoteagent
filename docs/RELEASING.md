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
5. Restart `remoteagent.service` on server 30 if runtime code changed
6. Verify the relevant runtime path, logs, or Telegram behavior
7. Commit the completed work
8. Push `main` to `origin/main`
9. Update machine 21's npm-installed runtime after server 30 deployment

If step 7 or step 8 is missing, the work is not done.
If server 30 was updated but machine 21 was not updated, the deployment is incomplete.

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

Typical release sequence on server 30:

```bash
cd /home/au2223/projects/remoteagent
./scripts/bump-version.sh minor
/home/au2223/.local/bin/npm run check
/home/au2223/.local/bin/npm run build
sudo systemctl restart remoteagent
git status
git add -A
git commit -m "Release 0.2.0"
git push origin main
```

## Machine 21 follow-up

Server 30 is the source of truth.
After a deployment on server 30, machine 21 must refresh its npm-installed runtime before the release can be treated as finished.

At minimum, the operator should run the local install/update flow again and verify the process comes back up cleanly.
