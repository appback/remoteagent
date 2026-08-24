#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE_NAME="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"

if [[ "$PACKAGE_NAME" != "appback-remoteagent" ]]; then
  echo "Unexpected package name: $PACKAGE_NAME" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files are not clean. Commit and push before publishing." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

UNTRACKED="$(git ls-files --others --exclude-standard)"
if [[ -n "$UNTRACKED" ]]; then
  echo "Untracked files are excluded from the release snapshot:"
  printf '%s\n' "$UNTRACKED"
  echo
fi

echo "Publishing $PACKAGE_NAME@$VERSION"
echo
echo "npm identity:"
npm whoami
echo
echo "npm owners:"
npm owner ls "$PACKAGE_NAME"
echo

npm run check
npm run build

STAGING_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

git archive --format=tar HEAD | tar -xf - -C "$STAGING_DIR"
cd "$STAGING_DIR"
npm ci --ignore-scripts
npm run check
npm run build

TARBALL="$(npm pack --silent)"

echo
echo "Publishing tarball: $TARBALL"
REMOTEAGENT_PUBLISH_GUARD_OK=1 npm publish "$TARBALL" --access public

echo
echo "Verifying registry version:"
npm view "$PACKAGE_NAME" version
