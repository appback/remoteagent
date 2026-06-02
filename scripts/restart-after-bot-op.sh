#!/usr/bin/env bash
set -u

SERVICE_NAME="${1:-remoteagent}"
DATA_DIR="${2:?data dir is required}"
PENDING_FILE="$DATA_DIR/pending-bot-operation.json"
ENV_FILE="$DATA_DIR/.env"
START_SCRIPT="$DATA_DIR/start-remoteagent.sh"
STOP_SCRIPT="$DATA_DIR/stop-remoteagent.sh"

log() {
  printf '[bot-op] %s\n' "$1" >&2
}

update_pending_status() {
  local status="$1"
  local reason="$2"
  python3 - "$PENDING_FILE" "$status" "$reason" <<'PY'
import json
import sys
from pathlib import Path
pending_path = Path(sys.argv[1])
status = sys.argv[2]
reason = sys.argv[3]
if not pending_path.exists():
    raise SystemExit(0)
obj = json.loads(pending_path.read_text())
obj['status'] = status
obj['reason'] = reason
pending_path.write_text(json.dumps(obj, indent=2) + '\n')
PY
}

restore_backup() {
  python3 - "$PENDING_FILE" "$ENV_FILE" <<'PY'
import json
import shutil
import sys
from pathlib import Path
pending_path = Path(sys.argv[1])
env_path = Path(sys.argv[2])
if not pending_path.exists():
    raise SystemExit(0)
obj = json.loads(pending_path.read_text())
backup = obj.get('backupEnvPath')
if backup and Path(backup).exists():
    shutil.copyfile(backup, env_path)
PY
}

wait_until_active() {
  local attempts=10
  local i=0
  while [ "$i" -lt "$attempts" ]; do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

wait_until_pid_running() {
  local pid_file="$1"
  local attempts=20
  local i=0

  while [ "$i" -lt "$attempts" ]; do
    if [ -f "$pid_file" ]; then
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 0.5
    i=$((i + 1))
  done

  return 1
}

restart_user_runtime() {
  if [ ! -x "$STOP_SCRIPT" ] || [ ! -x "$START_SCRIPT" ]; then
    return 1
  fi

  DATA_DIR="$DATA_DIR" "$STOP_SCRIPT" || true
  DATA_DIR="$DATA_DIR" "$START_SCRIPT" || return 1
  wait_until_pid_running "$DATA_DIR/remoteagent.pid"
}

sleep 1

if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  if systemctl restart "$SERVICE_NAME" && wait_until_active; then
    exit 0
  fi
else
  if restart_user_runtime; then
    exit 0
  fi
fi

reason="service did not become active after restart"
log "$reason"
update_pending_status "rolled_back" "$reason"
restore_backup

if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  systemctl restart "$SERVICE_NAME" || true
  wait_until_active || true
else
  restart_user_runtime || true
fi

exit 0
