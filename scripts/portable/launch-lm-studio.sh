#!/bin/bash
# LM Studio 0.4.24 rejects app bundles outside /Applications, including symlinks.
set -euo pipefail
portable_source="$(cd "$(dirname "$0")" && pwd -P)"
source "$portable_source/versions.sh"
portable_root="$(cd "${1:-$portable_source/../../.portable}" && pwd -P)"
mode="${2:-launch}"
case "$mode" in install|launch) ;; *) echo 'Expected install or launch.' >&2; exit 1 ;; esac
if [ "$mode" = launch ] && [ "${COPSE_PORTABLE_OFFLINE:-0}" = 1 ]; then
  echo 'Launch Services cannot enforce this shell sandbox on the GUI. Use install mode offline, or the standalone inference runtimes.' >&2
  exit 1
fi
source_app="$portable_root/apps/darwin-arm64/lm-studio-$LM_STUDIO_VERSION/LM Studio.app"
host_app="/Applications/LM Studio Copse $LM_STUDIO_VERSION.app"
verify_app() {
  /usr/bin/codesign --verify --deep --strict -R='anchor apple generic and certificate leaf[subject.OU] = "D65G88RHWN"' "$1"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist")" = "${LM_STUDIO_VERSION/-/+}"
}
if [ ! -d "$source_app" ]; then
  echo 'Install the pinned app first with make portable-local-ai-setup.' >&2
  exit 1
fi
verify_app "$source_app"
if [ -L "$host_app" ]; then echo "LM Studio requires a real app copy, not a symlink: $host_app" >&2; exit 1; fi
if [ ! -e "$host_app" ]; then
  # Never replace another installed version or an existing host installation.
  stage="$(mktemp -d '/Applications/.copse-lm-studio.XXXXXX')"
  trap 'rm -rf "$stage"' EXIT
  /usr/bin/ditto "$source_app" "$stage/LM Studio.app"
  verify_app "$stage/LM Studio.app"
  /bin/mv -n "$stage/LM Studio.app" "$host_app"
fi
verify_app "$host_app"
echo "Verified host app: $host_app"
echo "Drive models: $portable_root/models"
echo 'LM Studio uses the current macOS user profile. Select the drive model directory in its settings.'
if [ "$mode" = install ]; then exit 0; fi
# Launch Services otherwise silently activates an already-running host copy.
running="$(/usr/bin/pgrep -x 'LM Studio' || true)"
if [ -n "$running" ]; then
  echo 'Quit the running LM Studio app, then run this launcher again to start the pinned copy.' >&2
  exit 1
fi
/usr/bin/open -n "$host_app"
