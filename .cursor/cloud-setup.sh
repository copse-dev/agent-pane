#!/usr/bin/env bash
# Cloud-agent environment setup, referenced by .cursor/environment.json `install`.
# Runs from the repository root at VM setup/maintenance time. MUST stay idempotent
# (Cursor re-runs the update script on every snapshot refresh).
set -euo pipefail

# Pin Node to the version in .nvmrc. >=22.22.2 is required for native TypeScript
# type-stripping in scripts/*.mts.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install
nvm alias default "$(cat .nvmrc)"
# Activate the packageManager-pinned pnpm (Corepack ships with Node).
corepack enable
corepack prepare --activate

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
# the first `pnpm run dev` (avoids the documented first-launch SyntaxError race) and
# so `pnpm run check` / e2e can run immediately.
# Force scripts on: inherited npm_config_ignore_scripts=true overrides .npmrc and
# skips node-pty postinstall (posix_spawnp / spawn-helper).
npm_config_ignore_scripts=false pnpm install --frozen-lockfile
pnpm run build
