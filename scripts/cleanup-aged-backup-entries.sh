#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  cleanup-aged-backup-entries.sh --root <absolute-directory> --days <count> [--apply]

Without --apply, matching entries are printed but not removed. Only immediate
children of --root are considered.
EOF
}

root=""
days=""
apply=false

while (($# > 0)); do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      root="$2"
      shift 2
      ;;
    --days)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      days="$2"
      shift 2
      ;;
    --apply)
      apply=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$root" == /* && "$root" != "/" ]] || {
  printf 'cleanup_refused reason=invalid_root root=%q\n' "$root" >&2
  exit 2
}
[[ "$days" =~ ^[1-9][0-9]*$ ]] || {
  printf 'cleanup_refused reason=invalid_days days=%q\n' "$days" >&2
  exit 2
}
[[ -d "$root" && ! -L "$root" ]] || {
  printf 'cleanup_refused reason=root_not_directory root=%q\n' "$root" >&2
  exit 2
}

root="$(realpath -e -- "$root")"
removed=0
matched=0

while IFS= read -r -d '' candidate; do
  candidate="$(realpath -m -- "$candidate")"
  [[ "$(dirname -- "$candidate")" == "$root" && "$candidate" != "$root" ]] || {
    printf 'cleanup_refused reason=candidate_outside_root candidate=%q\n' "$candidate" >&2
    exit 1
  }

  matched=$((matched + 1))
  if [[ "$apply" == true ]]; then
    rm -rf --one-file-system -- "$candidate"
    removed=$((removed + 1))
    printf 'cleanup_removed path=%q\n' "$candidate"
  else
    printf 'cleanup_candidate path=%q\n' "$candidate"
  fi
done < <(find "$root" -mindepth 1 -maxdepth 1 -mtime "+$days" -print0)

printf 'cleanup_complete root=%q days=%s apply=%s matched=%s removed=%s\n' \
  "$root" "$days" "$apply" "$matched" "$removed"
