#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: npm run release:version -- <patch|minor|major>" >&2
  echo "Example: npm run release:version -- patch" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

case "$1" in
  patch|minor|major)
    ;;
  *)
    usage
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm version --no-git-tag-version "$1"
node -p "'RemoteAgent version is now ' + require('./package.json').version"
