# Sourced by setup.sh and run.sh, with portable_root already resolved.
# Keep the user's HOME and credentials separate from the development toolchain.
portable_tools="$portable_root/apps/darwin-arm64"
export PATH="$portable_tools/node/bin:$portable_tools/bin:$portable_tools/packages/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin"
export COPSE_DIR="$portable_root/data/copse"
export COPSE_PRESERVE_PATH=1
export COPSE_ELECTRON_DIST_CACHE="$portable_root/cache/electron-dist"
export COPSE_GORTEX_CACHE="$portable_root/cache/gortex"
export COREPACK_HOME="$portable_root/cache/corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_AUTO_PIN=0
export npm_config_cache="$portable_root/cache/npm"
export npm_config_store_dir="$portable_root/cache/pnpm"
export npm_config_devdir="$portable_root/cache/node-gyp"
export COPSE_ELECTRON_HEADERS_CACHE="$portable_root/cache/electron-headers"
export npm_config_userconfig="$portable_root/data/npmrc"
export XDG_CACHE_HOME="$portable_root/cache/xdg"
export ELECTRON_CACHE="$portable_root/cache/electron-downloads"
export electron_config_cache="$ELECTRON_CACHE"
export ELECTRON_BUILDER_CACHE="$portable_root/cache/electron-builder"
export TMPDIR="$portable_root/tmp/"
# Scratch directories inside a checkout must not inherit its Git identity.
# Repositories explicitly initialized below this ceiling still work normally.
export GIT_CEILING_DIRECTORIES="$portable_root/tmp${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}"
export CLAUDE_CONFIG_DIR="$portable_root/data/claude"
export CLAUDE_CODE_TMPDIR="$portable_root/tmp"
export DISABLE_UPDATES=1
export DISABLE_AUTOUPDATER=1
# Codex state is selected by its wrapper, never by changing the caller's CODEX_HOME.
export npm_config_python=/usr/bin/python3
export PYTHON=/usr/bin/python3
if [ "${COPSE_PORTABLE_OFFLINE:-0}" = 1 ]; then
  export npm_config_offline=true
  export COREPACK_ENABLE_NETWORK=0
fi
