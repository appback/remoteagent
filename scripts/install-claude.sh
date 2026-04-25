#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.profile" >/dev/null 2>&1 || true
npm install -g @anthropic-ai/claude-code
claude install
claude --version
