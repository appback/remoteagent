#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"

mkdir -p "$DATA_DIR" "$DATA_DIR/logs"

if [ ! -f "$DATA_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$DATA_DIR/.env"
  echo "Created $DATA_DIR/.env"
fi

npm --prefix "$ROOT_DIR" install
npm --prefix "$ROOT_DIR" run build

echo
echo "RemoteAgent is installed."
echo "Edit $DATA_DIR/.env and set TELEGRAM_BOT_TOKEN."
echo "Start with: $ROOT_DIR/scripts/start.sh"
