#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.profile" >/dev/null 2>&1 || true

token="${REMOTEAGENT_AUTH_TOKEN:-${CLAUDE_AUTH_TOKEN:-}}"
if [ -z "$token" ]; then
  echo "Missing token. Usage: /login claude <token>"
  exit 1
fi

verify_output="$(timeout 45s env ANTHROPIC_API_KEY="$token" CLAUDE_CODE_SIMPLE=1 claude --bare --print --output-format text "Reply exactly: claude token ok" 2>&1 || true)"
if ! printf '%s' "$verify_output" | grep -Fq 'claude token ok'; then
  printf '%s
' "$verify_output"
  echo
  echo "Claude token verification failed."
  exit 1
fi

env_file="$HOME/.remoteagent/.env"
mkdir -p "$(dirname "$env_file")"
touch "$env_file"
chmod 600 "$env_file"
python3 - "$env_file" "$token" <<'PY2'
from pathlib import Path
import sys
path = Path(sys.argv[1])
token = sys.argv[2]
lines = path.read_text(encoding='utf8').splitlines() if path.exists() else []
updated = []
seen = False
for line in lines:
    if line.startswith('ANTHROPIC_API_KEY='):
        if not seen:
            updated.append(f'ANTHROPIC_API_KEY={token}')
            seen = True
        continue
    updated.append(line)
if not seen:
    updated.append(f'ANTHROPIC_API_KEY={token}')
path.write_text('\n'.join(updated) + '\n', encoding='utf8')
PY2

sudo systemctl restart remoteagent
printf '%s

' "$verify_output"
echo "Claude token saved to ~/.remoteagent/.env as ANTHROPIC_API_KEY and remoteagent was restarted."
