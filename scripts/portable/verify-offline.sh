#!/bin/bash
# Reconstruct a disposable checkout from caches alone; never copy user profiles.
set -euo pipefail
portable_repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
portable_root="$1"
cd "$portable_repo"
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo 'Commit source changes before verifying offline setup: the check rebuilds the current commit.' >&2
  exit 1
fi
mkdir -p "$portable_root/validation"
verification="$(mktemp -d "$portable_root/validation/offline.XXXXXX")"
echo "Offline verification: $verification"
git clone --local --no-hardlinks --quiet "$portable_repo" "$verification/checkout"
mkdir -p "$verification/checkout/.portable"
# APFS copy-on-write copies retain bytes without sharing mutable cache files.
/bin/cp -cR "$portable_root/cache" "$verification/checkout/.portable/cache"
cd "$verification/checkout"
# In addition to denying networking, deny the usual host development caches.
# A passing test must not accidentally borrow the original Mac's headers/assets.
if /usr/bin/sandbox-exec -D "HOST_USER=$HOME" -p '
  (version 1) (allow default) (deny network*)
  (deny file-read* file-write*
    (subpath (string-append (param "HOST_USER") "/.electron-gyp"))
    (subpath (string-append (param "HOST_USER") "/.electron-rebuild-cache"))
    (subpath (string-append (param "HOST_USER") "/.node-gyp"))
    (subpath (string-append (param "HOST_USER") "/.npm"))
    (subpath (string-append (param "HOST_USER") "/.cache"))
    (subpath (string-append (param "HOST_USER") "/.copse/cache"))
    (subpath (string-append (param "HOST_USER") "/Library/Caches")))
' /usr/bin/env COPSE_PORTABLE_OFFLINE=1 bash scripts/portable/setup.sh > "$verification/build.log" 2>&1; then
  {
    echo 'PASS: clean checkout installed and built using only drive caches.'
    echo 'Network access and common host development caches were denied.'
    echo "Commit: $(git rev-parse HEAD)"
    echo "macOS: $(sw_vers -productVersion), $(uname -m)"
    echo 'This verifies setup/build, not cloud inference, authentication, or another Mac.'
  } | tee "$verification/result.txt"
else
  tail -60 "$verification/build.log" >&2
  echo "Offline verification failed. Full log: $verification/build.log" >&2
  exit 1
fi
