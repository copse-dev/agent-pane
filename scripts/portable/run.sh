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
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This environment requires native Apple Silicon macOS.' >&2
  exit 1
fi
source "$portable_repo/scripts/portable/environment.sh"
source "$portable_repo/scripts/portable/versions.sh"
cd "$portable_repo"
case "${1:-doctor}" in
  doctor)
    test -d .git || { echo 'An independent clone is required, not a linked worktree.' >&2; exit 1; }
    test "$(node -p 'process.versions.node')" = "$NODE_VERSION"
    test "$(pnpm --version)" = "$PNPM_VERSION"
    /usr/bin/xcrun --find clang
    /usr/bin/python3 --version
    for tool in node corepack pnpm rg claude codex claude-agent-acp codex-acp; do
      command -v "$tool"
    done
    claude --version
    codex --version
    echo "pnpm store: $(pnpm store path)"
    echo "Copse profile: $COPSE_DIR"
    echo 'Host dependencies: macOS, Xcode/Command Line Tools (Git, make, Python, SDK), Keychain.'
    echo 'Electron rebuild still uses the host ~/.electron-gyp cache. Offline readiness is not certified.'
    ;;
  prepare)
    # Explicitly online/rebuilding. The normal launcher never clears a working
    # dependency tree in response to an absent download while travelling offline.
    rm -f "$portable_root/.copse-prepared-path"
    if [ "$(cat "$portable_root/.copse-installed-path" 2>/dev/null || true)" != "$(pwd -P)" ]; then
      # pnpm stores some absolute paths in its metadata and generated commands.
      # Force reconciliation after relocation, even when package inputs match.
      rm -f .tmp/dev-dependencies.fingerprint
    fi
    /usr/bin/make USE_NVM=: build
    pwd -P > "$portable_root/.copse-installed-path"
    pwd -P > "$portable_root/.copse-prepared-path"
    ;;
  run)
    if [ "$(cat "$portable_root/.copse-prepared-path" 2>/dev/null || true)" != "$(pwd -P)" ]; then
      echo 'Checkout moved or setup is incomplete. Run ./portable-dev prepare while online first.' >&2
      exit 1
    fi
    if ! /usr/bin/grep -q COPSE_PRESERVE_PATH src/main/app-init.ts && [ ! -f src/main/launch-path.ts ]; then
      echo 'Launching with the drive PATH requires Copse PR #2657 (portable-launch-path).' >&2
      exit 1
    fi
    exec pnpm start
    ;;
  shell)
    # No host rc files: nvm/fnm and Homebrew must not replace the pinned tools.
    export PS1='portable \w $ '
    exec /bin/bash --noprofile --norc -i
    ;;
  exec)
    shift
    test "$#" -gt 0
    exec "$@"
    ;;
  *) echo 'Usage: portable-dev {doctor|prepare|run|shell|exec COMMAND...}' >&2; exit 1 ;;
esac
