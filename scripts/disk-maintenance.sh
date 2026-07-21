#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/disk-maintenance.sh <report|prune-safe|prune-workspaces|prune-codex-sessions> [days]

Examples:
  scripts/disk-maintenance.sh report
  scripts/disk-maintenance.sh prune-safe
  scripts/disk-maintenance.sh prune-workspaces
  scripts/disk-maintenance.sh prune-codex-sessions 45

Notes:
  report              Prints disk, Docker, workspace, cache, and large-file usage.
  prune-safe          Removes Docker build cache, old RemoteAgent temp dirs, and orphan managed workspaces only.
  prune-workspaces    Removes only managed workspace directories not referenced by RemoteAgent state.
  prune-codex-sessions <days>
                      Archives Codex session jsonl files older than <days> into ~/.codex/session-archive.
                      This can break resume for archived old sessions, so it must be explicit.
USAGE
}

ACTION="${1:-}"
RETENTION_DAYS="${2:-}"
DATA_DIR="${DATA_DIR:-$HOME/.remoteagent}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/workspaces/remoteagent}"
CODEX_SESSIONS_DIR="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
CODEX_ARCHIVE_DIR="${CODEX_ARCHIVE_DIR:-$HOME/.codex/session-archive}"

if [[ -z "$ACTION" ]]; then
  usage
  exit 1
fi

require_integer_days() {
  local value="$1"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [[ "$value" -lt 1 ]]; then
    echo "Retention days must be a positive integer." >&2
    exit 1
  fi
}

print_section() {
  printf '\n== %s ==\n' "$1"
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

report() {
  print_section "filesystem"
  df -hT /

  print_section "top level"
  sudo -n du -xhd1 / 2>/dev/null | sort -h | tail -30 || du -xhd1 "$HOME" 2>/dev/null | sort -h | tail -30 || true

  print_section "home"
  du -xhd1 "$HOME" 2>/dev/null | sort -h | tail -50 || true

  if [[ -d "$WORKSPACE_ROOT" ]]; then
    print_section "remoteagent workspaces"
    du -xhd1 "$WORKSPACE_ROOT" 2>/dev/null | sort -h | tail -80 || true
    print_section "orphan managed workspaces"
    orphan_workspaces dry-run
  fi

  if [[ -d "$CODEX_SESSIONS_DIR" ]]; then
    print_section "codex sessions"
    du -xhd1 "$HOME/.codex" "$CODEX_SESSIONS_DIR" 2>/dev/null | sort -h | tail -40 || true
  fi

  print_section "tmp"
  du -xhd1 /tmp 2>/dev/null | sort -h | tail -50 || true

  if docker_available; then
    print_section "docker system df"
    docker system df || true
  fi

  print_section "largest files over 200M"
  sudo -n find "$HOME" /var /tmp -xdev -type f -size +200M -printf '%s\t%p\n' 2>/dev/null \
    | sort -n \
    | tail -80 \
    | awk '{size=$1/1024/1024/1024; $1=""; sub(/^\t/, ""); printf "%.2fG\t%s\n", size, $0}' || true
}

orphan_workspaces() {
  local mode="${1:-dry-run}"
  python3 - "$DATA_DIR" "$WORKSPACE_ROOT" "$mode" <<'PY'
import json
import os
import shutil
import subprocess
import sys

data_dir, workspace_root, mode = sys.argv[1:4]
state_path = os.path.join(data_dir, "state.json")

def size_label(path):
    try:
        return subprocess.check_output(["du", "-sh", path], text=True).split()[0]
    except Exception:
        return "?"

if not os.path.isdir(workspace_root):
    print(f"workspace root not found: {workspace_root}")
    sys.exit(0)

try:
    with open(state_path, "r", encoding="utf-8") as handle:
        state = json.load(handle)
except Exception as exc:
    print(f"state unavailable, refusing workspace cleanup: {exc}")
    sys.exit(0 if mode == "dry-run" else 1)

referenced = set()
for session in (state.get("sessions") or {}).values():
    workspace = session.get("workspace") or session.get("workspacePath")
    if isinstance(workspace, str):
        normalized = os.path.abspath(workspace)
        root = os.path.abspath(workspace_root)
        if normalized == root or normalized.startswith(root + os.sep):
            referenced.add(os.path.basename(normalized.rstrip(os.sep)))

all_dirs = {
    name for name in os.listdir(workspace_root)
    if os.path.isdir(os.path.join(workspace_root, name))
}
orphans = sorted(all_dirs - referenced)

print(f"referenced={len(referenced)} all={len(all_dirs)} orphan={len(orphans)}")
for name in orphans:
    path = os.path.join(workspace_root, name)
    print(f"{size_label(path)}\t{name}")
    if mode == "delete":
        shutil.rmtree(path, ignore_errors=True)
PY
}

prune_safe() {
  print_section "before"
  df -hT /

  if docker_available; then
    print_section "docker builder prune"
    docker builder prune -f
  else
    print_section "docker builder prune skipped"
    echo "docker is unavailable or current user cannot access it"
  fi

  print_section "old temp directories"
  find /tmp -maxdepth 1 -mindepth 1 -type d \
    \( -name 'remoteagent-codex-*' -o -name 'remoteagent-claude-*' -o -name 'appback-*' \) \
    -mtime +2 -print -exec rm -rf {} +

  print_section "orphan managed workspaces"
  orphan_workspaces delete

  print_section "after"
  df -hT /
}

prune_codex_sessions() {
  local days="$1"
  require_integer_days "$days"

  if [[ ! -d "$CODEX_SESSIONS_DIR" ]]; then
    echo "Codex sessions dir not found: $CODEX_SESSIONS_DIR"
    exit 0
  fi

  mkdir -p "$CODEX_ARCHIVE_DIR"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local list_file archive_file
  list_file="$(mktemp)"
  archive_file="$CODEX_ARCHIVE_DIR/codex-sessions-older-than-${days}d-$stamp.tar.gz"
  find "$CODEX_SESSIONS_DIR" -type f -name '*.jsonl' -mtime +"$days" -print > "$list_file"

  if [[ ! -s "$list_file" ]]; then
    rm -f "$list_file"
    echo "No Codex session files older than ${days}d."
    exit 0
  fi

  tar -czf "$archive_file" --files-from "$list_file"
  while IFS= read -r file; do
    rm -f "$file"
  done < "$list_file"
  rm -f "$list_file"

  find "$CODEX_SESSIONS_DIR" -type d -empty -delete
  echo "Archived old Codex session files to $archive_file"
}

case "$ACTION" in
  report)
    report
    ;;
  prune-safe)
    prune_safe
    ;;
  prune-workspaces)
    orphan_workspaces delete
    ;;
  prune-codex-sessions)
    prune_codex_sessions "${RETENTION_DAYS:-}"
    ;;
  *)
    usage
    exit 1
    ;;
esac
