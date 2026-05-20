#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
ENV_FILE="$DATA_DIR/.env"

mkdir -p "$DATA_DIR" "$DATA_DIR/logs"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE"
fi

upsert_env() {
  local key="$1"
  local value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
text = path.read_text() if path.exists() else ""
lines = text.splitlines()
out = []
updated = False
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={value}")
        updated = True
    else:
        out.append(line)
if not updated:
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
}

upsert_env "SETUP_COMMAND_TIMEOUT_MS" "600000"
upsert_env "CODEX_INSTALL_COMMAND" "$ROOT_DIR/scripts/install-codex.sh"
upsert_env "CLAUDE_INSTALL_COMMAND" "$ROOT_DIR/scripts/install-claude.sh"
upsert_env "CLAUDE_LOGIN_START_COMMAND" "$ROOT_DIR/scripts/start-claude-login.sh"
upsert_env "CLAUDE_LOGIN_FINISH_COMMAND" "$ROOT_DIR/scripts/finish-claude-login.sh"

npm --prefix "$ROOT_DIR" install
npm --prefix "$ROOT_DIR" run build

echo
echo "RemoteAgent is installed."
echo "Provider install/login hooks were configured in $ENV_FILE"
echo "Set TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKENS in $ENV_FILE"
echo "Start with: $ROOT_DIR/scripts/start.sh"