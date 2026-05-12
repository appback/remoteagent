#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <patch|minor|major>" >&2
  exit 1
fi

case "$1" in
  patch|minor|major)
    ;;
  *)
    echo "Release type must be one of: patch, minor, major" >&2
    exit 1
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
cd "$ROOT_DIR"

npm version --no-git-tag-version "$1"
node -p "'RemoteAgent version is now ' + require('./package.json').version"
