#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.profile" >/dev/null 2>&1 || true
timeout 15s claude auth login || true
