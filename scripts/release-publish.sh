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

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit and push before publishing." >&2
  git status --short >&2
  exit 1
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

TARBALL="$(npm pack --silent)"
cleanup() {
  rm -f "$TARBALL"
}
trap cleanup EXIT

echo
echo "Publishing tarball: $TARBALL"
REMOTEAGENT_PUBLISH_GUARD_OK=1 npm publish "$TARBALL" --access public

echo
echo "Verifying registry version:"
npm view "$PACKAGE_NAME" version
