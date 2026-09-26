#!/bin/bash
# Enforce offline operation for package managers AND arbitrary lifecycle scripts.
set -euo pipefail
if [ ! -x /usr/bin/sandbox-exec ]; then
  echo 'Offline setup requires macOS sandbox-exec to block network access.' >&2
  exit 1
fi
exec /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  /usr/bin/env COPSE_PORTABLE_OFFLINE=1 "$@"
