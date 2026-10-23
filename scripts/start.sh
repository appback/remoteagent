#!/usr/bin/env bash
set -euo pipefail

script_dir() {
  local source="$1"
  while [ -L "$source" ]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    case "$source" in
      /*) ;;
      *) source="$dir/$source" ;;
    esac
  done
  cd -P "$(dirname "$source")" && pwd
}

ROOT_DIR="$(cd "$(script_dir "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
PID_FILE="$DATA_DIR/remoteagent.pid"
LOG_FILE="$DATA_DIR/logs/agent.log"
NODE_BIN="${NODE_BIN:-node}"
ENV_FILE="$DATA_DIR/.env"

mkdir -p "$DATA_DIR" "$(dirname "$LOG_FILE")"

if [[ "$(uname -s)" == "Darwin" && -f "$HOME/Library/LaunchAgents/app.remoteagent.runtime.plist" ]]; then
  exec "$NODE_BIN" "$ROOT_DIR/scripts/macos-service.mjs" start
fi

if systemctl --user cat remoteagent >/dev/null 2>&1; then
  if systemctl is-active --quiet remoteagent || systemctl is-enabled --quiet remoteagent; then
    echo "System service still active/enabled. Run remoteagent service migrate first." >&2
    exit 1
  fi
  systemctl --user start remoteagent
  systemctl --user is-active remoteagent
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl cat remoteagent >/dev/null 2>&1; then
  if sudo -n true >/dev/null 2>&1; then
    sudo systemctl start remoteagent
    sudo systemctl status remoteagent --no-pager -l --lines=5 || true
    exit 0
  fi

  echo "remoteagent.service is installed. Use sudo systemctl start remoteagent." >&2
  exit 1
fi

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
STARTED_PID=$!
for ATTEMPT in {1..50}; do
  if [[ -f "$PID_FILE" && "$(cat "$PID_FILE")" == "$STARTED_PID" ]] && kill -0 "$STARTED_PID" 2>/dev/null; then
    echo "RemoteAgent started with PID $STARTED_PID"
    echo "Logs: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$STARTED_PID" 2>/dev/null; then
    echo "RemoteAgent startup failed. Logs: $LOG_FILE" >&2
    exit 1
  fi
  sleep 0.1
done
echo "RemoteAgent PID ownership was not confirmed. Inspect $LOG_FILE before starting again." >&2
exit 1
