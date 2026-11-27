#!/usr/bin/env bash
# Claude Code cloud-session setup. The Claude Code cloud environment's setup
# script calls this from the directory that holds the checkout:
#
#   [ -f agent-pane/.claude/cloud-setup.sh ] && (cd agent-pane && bash .claude/cloud-setup.sh)
#
# It also works by hand from the repository root: `bash .claude/cloud-setup.sh`.
# Runs as root on each fresh container. MUST stay idempotent and non-interactive.
# The Cursor equivalent is .cursor/cloud-setup.sh; docs/agent-development.md
# ("Claude Code cloud sessions") describes what each step is for.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

log() { printf '[cloud-setup] %s\n' "$*"; }

# 1) Node 24. The image's default node is 22, which check-node-version.cjs
#    rejects. ~/.local/bin precedes /opt/node22/bin on the image's PATH, so
#    links there make Node 24 the default for every later shell too.
if [ -x /opt/node24/bin/node ]; then
  mkdir -p "$HOME/.local/bin"
  for bin in node npm npx corepack; do
    ln -sf "/opt/node24/bin/$bin" "$HOME/.local/bin/$bin"
  done
  export PATH="$HOME/.local/bin:$PATH"
fi
node scripts/check-node-version.cjs
log "node $(node -v)"

# pnpm at the packageManager-pinned version, through Corepack.
if ! pnpm --version >/dev/null 2>&1 || [ "$(command -v pnpm)" != "$HOME/.local/bin/pnpm" ]; then
  corepack enable --install-directory "$HOME/.local/bin"
fi
corepack prepare --activate >/dev/null
log "pnpm $(pnpm --version)"

# 2) System packages CI installs on hosted runners: the project sandbox needs
#    bubblewrap and socat; SSH tests need ssh-keygen; the reference
#    screenshots use CI's Noto fonts. A blocked apt is reported, not fatal:
#    unit tests outside the sandbox still run, and the e2e launcher stops with
#    a named cause instead.
packages=(bubblewrap socat openssh-client fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji)
if command -v apt-get >/dev/null 2>&1 && ! dpkg -s "${packages[@]}" >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  if apt-get update -qq && apt-get install -y -qq --no-install-recommends "${packages[@]}"; then
    log "installed ${packages[*]}"
  else
    log "WARNING: apt-get could not install ${packages[*]}; sandbox and screenshot tests will not run"
  fi
fi

# 3) Dependencies and a valid dist/. Force lifecycle scripts on: an inherited
#    npm_config_ignore_scripts=true skips node-pty's postinstall.
npm_config_ignore_scripts=false pnpm install --frozen-lockfile
node scripts/check-prepared-worktree.mts
pnpm run build
log "ready: pnpm test -- <filter>, pnpm run test:e2e:ci -- --spec tests/e2e/<name>.e2e.ts"
