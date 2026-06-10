#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
ENV_FILE="$DATA_DIR/.env"
APP_DIR="${REMOTEAGENT_APP_DIR:-$DATA_DIR/app/remoteagent-src}"
REMOTEAGENT_REPO_TARBALL="${REMOTEAGENT_REPO_TARBALL:-https://github.com/appback/remoteagent/archive/refs/heads/main.tar.gz}"

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  ROOT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")/.." && pwd)"
else
  ROOT_DIR="$APP_DIR"
  mkdir -p "$ROOT_DIR"
  tmp_dir="$(mktemp -d)"
  cleanup() {
    rm -rf "$tmp_dir"
  }
  trap cleanup EXIT
  echo "Downloading RemoteAgent source..."
  curl -fsSL "$REMOTEAGENT_REPO_TARBALL" -o "$tmp_dir/remoteagent.tar.gz"
  tar -xzf "$tmp_dir/remoteagent.tar.gz" -C "$tmp_dir"
  extracted_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [ -z "$extracted_dir" ]; then
    echo "Failed to extract RemoteAgent source." >&2
    exit 1
  fi
  rm -rf "$ROOT_DIR"
  mkdir -p "$ROOT_DIR"
  cp -a "$extracted_dir"/. "$ROOT_DIR"/
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

npm --prefix "$ROOT_DIR" install
npm --prefix "$ROOT_DIR" run build

echo
echo "RemoteAgent is installed."
echo "Provider install/login hooks were configured in $ENV_FILE"
echo "Set TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKENS in $ENV_FILE"
echo "Start with: $ROOT_DIR/scripts/start.sh"
