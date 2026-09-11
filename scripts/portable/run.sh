#!/bin/bash
set -euo pipefail
portable_root="$(cd "$(dirname "$0")" && pwd -P)"
checkout="$(cat "$portable_root/.copse-checkout")"
if [ "$checkout" = .. ] && [ "$(basename "$portable_root")" = .portable ]; then
  portable_repo="$(cd "$portable_root/.." && pwd -P)"
else
  if [[ "$checkout" != projects/* ]] || [[ "/$checkout/" = *'/../'* ]] || [[ "$checkout" = *$'\n'* ]]; then
    echo 'Invalid .copse-checkout: expected a path inside projects/.' >&2
    exit 1
  fi
  portable_repo="$(cd "$portable_root/$checkout" && pwd -P)"
  case "$portable_repo" in
    "$portable_root/projects/"*) ;;
    *) echo 'Checkout resolves outside this environment.' >&2; exit 1 ;;
  esac
fi
if [ "${2:-}" = --offline ]; then
  action="$1"
  shift 2
  exec bash "$portable_repo/scripts/portable/offline.sh" bash "$portable_root/portable-dev" "$action" "$@"
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This environment requires native Apple Silicon macOS.' >&2
  exit 1
fi
# Reset inherited credentials, provider routing and runtime injection before any tool starts.
exec /bin/bash "$portable_repo/scripts/portable/clean-environment.sh" \
  /bin/bash "$portable_repo/scripts/portable/dispatch.sh" "$portable_root" "$portable_repo" "$@"
