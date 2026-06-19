#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
ENV_FILE="$DATA_DIR/.env"
PACKAGE_NAME="${REMOTEAGENT_PACKAGE_NAME:-appback-remoteagent}"
PACKAGE_VERSION="${REMOTEAGENT_VERSION:-latest}"

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

find_global_package_root() {
  local global_root
  global_root="$(npm root -g)"
  if [ -d "$global_root/$PACKAGE_NAME" ]; then
    printf '%s\n' "$global_root/$PACKAGE_NAME"
    return 0
  fi
  return 1
}

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  ROOT_DIR="$(cd "$(script_dir "$SCRIPT_SOURCE")/.." && pwd)"
else
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install RemoteAgent." >&2
    exit 1
  fi
  echo "Installing $PACKAGE_NAME@$PACKAGE_VERSION from npm..."
  npm install -g "$PACKAGE_NAME@$PACKAGE_VERSION"
  ROOT_DIR="$(find_global_package_root)"
fi

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
upsert_env "BOT_RESTART_HELPER_PATH" "$ROOT_DIR/scripts/restart-after-bot-op.sh"

cat > "$DATA_DIR/start-remoteagent.sh" <<EOF
#!/usr/bin/env bash
DATA_DIR="$DATA_DIR" "$ROOT_DIR/scripts/start.sh"
EOF
chmod +x "$DATA_DIR/start-remoteagent.sh"

cat > "$DATA_DIR/stop-remoteagent.sh" <<EOF
#!/usr/bin/env bash
DATA_DIR="$DATA_DIR" "$ROOT_DIR/scripts/stop.sh"
EOF
chmod +x "$DATA_DIR/stop-remoteagent.sh"

echo
echo "RemoteAgent is installed."
echo "Provider install/login hooks were configured in $ENV_FILE"
echo "Set TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKENS in $ENV_FILE"
echo "Start with: remoteagent-start"
