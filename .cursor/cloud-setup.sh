#!/usr/bin/env bash
# Cloud-agent environment setup, referenced by .cursor/environment.json `install`.
# Runs from the repository root at VM setup/maintenance time. MUST stay idempotent
# (Cursor re-runs the update script on every snapshot refresh).
set -euo pipefail

# Pin Node to the version in .nvmrc. >=22.18 is required: the build/check tooling
# (scripts/*.mts) relies on Node's native TypeScript type-stripping, which older
# 22.x releases (e.g. the 22.14 that ships as some base-image defaults) lack and
# fail with `ERR_UNKNOWN_FILE_EXTENSION` for ".mts".
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install
nvm alias default "$(cat .nvmrc)"

# Make the pinned Node the default for the agent's future shells so it wins over
# any older system node on PATH.
if ! grep -q 'NVM_DIR' "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ''
    echo 'export NVM_DIR="$HOME/.nvm"'
    echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
  } >>"$HOME/.bashrc"
fi

# Install dependencies and prebuild so `dist/` already holds a valid bundle before
# the first `npm run dev` (avoids the documented first-launch SyntaxError race) and
# so `npm run check` / e2e can run immediately.
npm ci
npm run build
