#!/usr/bin/env bash
set -euo pipefail
if [ -f "$HOME/.profile" ]; then
  source "$HOME/.profile" >/dev/null 2>&1 || true
fi
export PATH="$HOME/.local/bin:$PATH"
timeout 15s claude auth login || true
