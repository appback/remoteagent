#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.profile" >/dev/null 2>&1 || true
mkdir -p "$HOME/.local/bin"
npm install -g @openai/codex
prefix="$(npm prefix -g)"
ln -sf "$prefix/bin/codex" "$HOME/.local/bin/codex"
codex --version
