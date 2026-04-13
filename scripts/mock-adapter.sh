#!/usr/bin/env bash
set -euo pipefail

printf '[mock:%s][session:%s] %s\n' \
  "${BRIDGE_PROVIDER}" \
  "${BRIDGE_SESSION_ID}" \
  "${BRIDGE_MESSAGE}"
