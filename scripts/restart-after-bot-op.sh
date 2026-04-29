#!/usr/bin/env bash
set -u

SERVICE_NAME="${1:-remoteagent}"
DATA_DIR="${2:?data dir is required}"
PENDING_FILE="$DATA_DIR/pending-bot-operation.json"
ENV_FILE="$DATA_DIR/.env"

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

sleep 1

if systemctl restart "$SERVICE_NAME" && wait_until_active; then
  exit 0
fi

reason="service did not become active after restart"
log "$reason"
update_pending_status "rolled_back" "$reason"
restore_backup
systemctl restart "$SERVICE_NAME" || true
wait_until_active || true
exit 0
