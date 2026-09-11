#!/bin/bash
# Public runtime software only. Does not switch LM Studio's per-user profile.
set -euo pipefail
portable_source="$(cd "$(dirname "$0")" && pwd -P)"
if [ "${1:-}" = --offline ]; then
  shift
  exec bash "$portable_source/offline.sh" bash "$portable_source/runtime-setup.sh" "$@"
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'The pinned local AI runtimes require Apple Silicon macOS.' >&2
  exit 1
fi
source "$portable_source/download.sh"
umask 077
mkdir -p "${1:-$portable_source/../../.portable}"
portable_root="$(cd "${1:-$portable_source/../../.portable}" && pwd -P)"
cache="$portable_root/cache/downloads/lm-studio-runtimes"
runtime_root="$portable_root/apps/darwin-arm64/lm-studio-runtimes"
backup="$runtime_root.previous"
if [ -e "$backup" ] || [ -L "$backup" ]; then
  echo "A previous runtime installation needs recovery: $backup" >&2
  exit 1
fi
if ! mkdir "$portable_root/.local-ai-runtime-setup-lock" 2>/dev/null; then
  echo 'Another runtime setup is running (or left .local-ai-runtime-setup-lock after interruption).' >&2
  exit 1
fi
stage=''
installed=0
complete=0
cleanup() {
  if [ "$installed" = 1 ] && [ "$complete" = 0 ]; then
    rm -rf "$runtime_root"
    if [ -e "$backup" ] || [ -L "$backup" ]; then mv "$backup" "$runtime_root"; fi
  fi
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
  rmdir "$portable_root/.local-ai-runtime-setup-lock"
}
trap cleanup EXIT
mkdir -p "$cache" "$(dirname "$runtime_root")"
stage="$(mktemp -d "$(dirname "$runtime_root")/.lm-studio-runtimes.XXXXXX")"
while IFS=$'\t' read -r destination url checksum; do
  archive="$cache/$checksum.archive"
  download "$url" "$archive" "$checksum"
  mkdir -p "$stage/$destination"
  /usr/bin/tar -xzf "$archive" -C "$stage/$destination"
  metadata="$portable_source/runtime-metadata/$destination.json"
  if [ -f "$metadata" ]; then cp "$metadata" "$stage/$destination/display-data.json"; fi
done < "$portable_source/runtimes.tsv"
if [ -e "$runtime_root" ] || [ -L "$runtime_root" ]; then mv "$runtime_root" "$backup"; fi
installed=1
mv "$stage" "$runtime_root"
stage=''
python="$runtime_root/vendor/_amphibian/cpython3.11-mac-arm64@10/bin/python3.11"
# Vendor postinstall regenerates absolute venv paths. Always repeat after relocation.
for layer in "$runtime_root"/vendor/_amphibian/*; do
  "$python" -I -S "$layer/postinstall.py"
done
complete=1
if [ -e "$backup" ] || [ -L "$backup" ]; then rm -rf "$backup"; fi
echo "Installed pinned runtimes: $runtime_root"
echo 'Host LM Studio settings are unchanged. Rerun portable-local-ai-runtimes-offline after moving the drive.'
