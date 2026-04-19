#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
PID_FILE="$DATA_DIR/remoteagent.pid"
LOG_FILE="$DATA_DIR/logs/agent.log"
NODE_BIN="${NODE_BIN:-node}"
ENV_FILE="$DATA_DIR/.env"

mkdir -p "$DATA_DIR" "$(dirname "$LOG_FILE")"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "RemoteAgent is already running with PID $(cat "$PID_FILE")"
  exit 0
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

nohup env DATA_DIR="$DATA_DIR" "$NODE_BIN" "$ROOT_DIR/dist/index.js" >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

echo "RemoteAgent started with PID $(cat "$PID_FILE")"
echo "Logs: $LOG_FILE"
