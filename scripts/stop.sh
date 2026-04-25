#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
PID_FILE="$DATA_DIR/remoteagent.pid"

if command -v systemctl >/dev/null 2>&1 && systemctl cat remoteagent >/dev/null 2>&1; then
  if sudo -n true >/dev/null 2>&1; then
    sudo systemctl stop remoteagent
    exit 0
  fi

  echo "remoteagent.service is installed. Use sudo systemctl stop remoteagent." >&2
  exit 1
fi

if [ ! -f "$PID_FILE" ]; then
  echo "RemoteAgent is not running."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  wait_for_exit=0
  while kill -0 "$PID" 2>/dev/null; do
    wait_for_exit=$((wait_for_exit + 1))
    if [ "$wait_for_exit" -ge 20 ]; then
      kill -9 "$PID" 2>/dev/null || true
      break
    fi
    sleep 0.2
  done
  echo "Stopped RemoteAgent PID $PID"
else
  echo "RemoteAgent PID file existed, but process was not running."
fi

rm -f "$PID_FILE"
