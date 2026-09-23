#!/usr/bin/env bash
set -euo pipefail
if [ -f "$HOME/.profile" ]; then
  source "$HOME/.profile" >/dev/null 2>&1 || true
fi
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"
npm install -g @openai/codex
prefix="$(npm prefix -g)"
if [ "$(cd "$prefix/bin" && pwd -P)" != "$(cd "$HOME/.local/bin" && pwd -P)" ]; then
  ln -sf "$prefix/bin/codex" "$HOME/.local/bin/codex"
fi
codex --version
