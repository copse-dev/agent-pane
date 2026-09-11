#!/bin/bash
# Bootstrap with macOS system tools; no host Node, pnpm or Homebrew required.
set -euo pipefail
portable_source="$(cd "$(dirname "$0")" && pwd -P)"
portable_repo="$(cd "$portable_source/../.." && pwd -P)"
if [ "${1:-}" = --offline ]; then
  shift
  exec bash "$portable_source/offline.sh" bash "$portable_source/setup.sh" "$@"
fi
if [ "$#" -gt 1 ]; then
  echo 'Usage: bash scripts/portable/setup.sh [--offline] [ROOT] (default: checkout/.portable)' >&2
  exit 1
fi
requested_root="${1:-$portable_repo/.portable}"
mkdir -p "$requested_root"
portable_root="$(cd "$requested_root" && pwd -P)"
if [ "$portable_root" = "$portable_repo/.portable" ]; then
  checkout_path=..
else
  case "$portable_repo" in
    "$portable_root/projects/"*) checkout_path="${portable_repo#"$portable_root/"}" ;;
    *) echo 'Use checkout/.portable, or place the checkout inside ROOT/projects/.' >&2; exit 1 ;;
  esac
fi
if [ ! -d "$portable_repo/.git" ] || [ -f "$portable_repo/.git/objects/info/alternates" ]; then
  echo 'An independent Git clone without shared object storage is required.' >&2
  exit 1
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This first portable environment supports native Apple Silicon macOS only.' >&2
  exit 1
fi
# Fail before downloads or changes when native build prerequisites are absent.
/usr/bin/xcrun --find clang >/dev/null
/usr/bin/python3 --version
/usr/bin/git --version
# shellcheck source=versions.sh
source "$portable_source/versions.sh"
if [ "$(cat "$portable_repo/.nvmrc")" != "$NODE_VERSION" ]; then
  echo 'Update portable/versions.sh and its checksum to match .nvmrc first.' >&2
  exit 1
fi
umask 077
mkdir -p "$portable_root/apps/darwin-arm64/bin" "$portable_root/cache/downloads" "$portable_root/models" "$portable_root/projects" \
  "$portable_root/data/copse" "$portable_root/data/claude" "$portable_root/data/codex" "$portable_root/tmp"
if ! mkdir "$portable_root/.portable-setup-lock" 2>/dev/null; then
  echo 'Another setup is running (or left .portable-setup-lock after interruption).' >&2
  exit 1
fi
trap 'rmdir "$portable_root/.portable-setup-lock"' EXIT
rm -f "$portable_root/.copse-prepared-path"
source "$portable_source/environment.sh"
touch "$npm_config_userconfig"

download() {
  local url="$1" destination="$2" checksum="$3" actual
  if [ -f "$destination" ]; then
    actual="$(/usr/bin/shasum -a 256 "$destination" | /usr/bin/cut -d ' ' -f 1)"
    if [ "$actual" = "$checksum" ]; then return; fi
  fi
  if [ "${COPSE_PORTABLE_OFFLINE:-0}" = 1 ]; then
    echo "Offline setup needs a valid cached download: $destination. Run portable-setup online first." >&2
    return 1
  fi
  /usr/bin/curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$url" -o "$destination.part"
  actual="$(/usr/bin/shasum -a 256 "$destination.part" | /usr/bin/cut -d ' ' -f 1)"
  if [ "$actual" != "$checksum" ]; then
    echo "Checksum mismatch: $url" >&2
    return 1
  fi
  mv "$destination.part" "$destination"
}

node_archive="$portable_root/cache/downloads/node-v$NODE_VERSION-darwin-arm64.tar.gz"
download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz" "$node_archive" "$NODE_SHA256"
node_release="$portable_tools/node-v$NODE_VERSION"
if [ ! -x "$node_release/bin/node" ]; then
  node_staging="$(mktemp -d "$portable_tools/.node.XXXXXX")"
  /usr/bin/tar -xzf "$node_archive" --strip-components=1 -C "$node_staging"
  mv "$node_staging" "$node_release"
fi
ln -sfn "node-v$NODE_VERSION" "$portable_tools/node"
node --version
if [ "$(node -p "require(process.argv[1]).packageManager" "$portable_repo/package.json")" != "pnpm@$PNPM_VERSION" ]; then
  echo 'Update portable/versions.sh to match packageManager first.' >&2
  exit 1
fi

claude_download="$portable_root/cache/downloads/claude-$CLAUDE_VERSION-darwin-arm64"
download "https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION/darwin-arm64/claude" "$claude_download" "$CLAUDE_SHA256"
cp "$claude_download" "$portable_tools/bin/claude"
chmod 755 "$portable_tools/bin/claude"

# npm is bundled with pinned Node. The separate lock covers all adapter transitive
# dependencies; no global install, unpinned npx, or host package manager is used.
mkdir -p "$portable_tools/packages"
cp "$portable_source/tools/package.json" "$portable_source/tools/package-lock.json" "$portable_tools/packages/"
npm ci --prefix "$portable_tools/packages" --ignore-scripts --no-audit --no-fund
# Codex's integrity-locked platform package includes a standalone ripgrep.
rg_relative=../packages/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path/rg
test -x "$portable_tools/bin/$rg_relative"
ln -sfn "$rg_relative" "$portable_tools/bin/rg"
# Replace Node's bundled Corepack entry with the separately locked release.
ln -sfn ../../packages/node_modules/corepack/dist/corepack.js "$portable_tools/node/bin/corepack"
corepack enable --install-directory "$portable_tools/node/bin"
corepack install --global "pnpm@$PNPM_VERSION"

# Do not copy the user's auth.json. New Codex profiles require the OS keychain.
if [ ! -f "$portable_root/data/codex/config.toml" ]; then
  printf '%s\n' 'cli_auth_credentials_store = "keyring"' > "$portable_root/data/codex/config.toml"
fi
cat > "$portable_tools/bin/codex" <<'WRAPPER'
#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
exec env CODEX_HOME="$root/data/codex" "$root/apps/darwin-arm64/packages/node_modules/.bin/codex" "$@"
WRAPPER
cat > "$portable_tools/bin/codex-acp" <<'WRAPPER'
#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
exec env CODEX_HOME="$root/data/codex" "$root/apps/darwin-arm64/packages/node_modules/.bin/codex-acp" "$@"
WRAPPER
chmod 755 "$portable_tools/bin/codex" "$portable_tools/bin/codex-acp"

# Remember a relative checkout name. Launchers discover the mount at each run.
printf '%s\n' "$checkout_path" > "$portable_root/.copse-checkout"
cp "$portable_source/run.sh" "$portable_root/portable-dev"
chmod 755 "$portable_root/portable-dev"
cat > "$portable_root/Open Dev Shell.command" <<'WRAPPER'
#!/bin/bash
exec "$(cd "$(dirname "$0")" && pwd -P)/portable-dev" shell
WRAPPER
cat > "$portable_root/Launch Copse.command" <<'WRAPPER'
#!/bin/bash
exec "$(cd "$(dirname "$0")" && pwd -P)/portable-dev" run
WRAPPER
chmod 755 "$portable_root/Open Dev Shell.command" "$portable_root/Launch Copse.command"
"$portable_root/portable-dev" doctor
"$portable_root/portable-dev" prepare
echo "Portable development setup complete: $portable_root"
