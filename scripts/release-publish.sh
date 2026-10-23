#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE_NAME="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"

verify_registry() {
  local published="" latest=""
  echo "Verifying registry version (bounded processing window):"
  for attempt in {1..36}; do
    published="$(npm view "$PACKAGE_NAME@$VERSION" version --prefer-online 2>/dev/null || true)"
    latest="$(npm view "$PACKAGE_NAME@latest" version --prefer-online 2>/dev/null || true)"
    echo "attempt=$attempt published=${published:-missing} latest=${latest:-missing}"
    if [[ "$published" == "$VERSION" && "$latest" == "$VERSION" ]]; then return 0; fi
    sleep 5
  done
  echo "Registry processing is not verified yet. Check again without republishing: npm run release:publish -- --verify-only" >&2
  return 1
}

if [[ "$PACKAGE_NAME" != "appback-remoteagent" ]]; then
  echo "Unexpected package name: $PACKAGE_NAME" >&2
  exit 1
fi

if [[ $# -eq 1 && "$1" == "--verify-only" ]]; then
  verify_registry
  exit $?
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: npm run release:publish [-- --verify-only]" >&2
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
npm run selftest:provider-install
node --test scripts/selftest-dot.mjs
node --test scripts/selftest-dot-host.mjs
node --test scripts/selftest-dot-mac.mjs
node --test scripts/selftest-dot-login.mjs
node --test scripts/selftest-dot-owner-auth.mjs
node --test scripts/selftest-g2.mjs scripts/selftest-g2-speech.mjs
if [[ -d clients/even-g2 ]]; then
  npm ci --ignore-scripts --prefix clients/even-g2
  npm run test --prefix clients/even-g2
  npm run pack --prefix clients/even-g2
fi
node --test scripts/selftest-runtime-lock.mjs
node --test scripts/selftest-dot-setup.mjs
if [[ -n "${PLAYWRIGHT_PACKAGE:-}" ]]; then
  node scripts/selftest-dot-browser.mjs
  node scripts/selftest-g2-browser.mjs
  G2_DEVICE_FLOW_TEST=1 node scripts/selftest-g2-browser.mjs
  G2_STANDALONE_TEST=1 G2_DEVICE_FLOW_TEST=1 node scripts/selftest-g2-browser.mjs
  if [[ -d clients/even-g2 ]]; then npm run test:ui --prefix clients/even-g2; fi
  node scripts/selftest-dot-login-browser.mjs
else
  echo "Optional browser gate not configured; set PLAYWRIGHT_PACKAGE and PLAYWRIGHT_EXECUTABLE to run it."
fi
node scripts/selftest-telegram-update.mjs
node scripts/selftest-session-dispatch.mjs
node scripts/selftest-codex-stream.mjs
node scripts/selftest-model-fallback.mjs
node scripts/selftest-codex-model-migration.mjs
node scripts/selftest-telegram-upload.mjs

TARBALL="$(npm pack --silent)"

echo
echo "Publishing tarball: $TARBALL"
REMOTEAGENT_PUBLISH_GUARD_OK=1 npm publish "$TARBALL" --access public

echo
verify_registry
