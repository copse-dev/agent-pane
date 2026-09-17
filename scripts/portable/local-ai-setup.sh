#!/bin/bash
# Optional large downloads: keep the default development bootstrap lightweight.
set -euo pipefail
portable_source="$(cd "$(dirname "$0")" && pwd -P)"
if [ "${1:-}" = --offline ]; then
  shift
  exec bash "$portable_source/offline.sh" bash "$portable_source/local-ai-setup.sh" "$@"
fi
portable_repo="$(cd "$portable_source/../.." && pwd -P)"
requested_root="${1:-$portable_repo/.portable}"
mkdir -p "$requested_root"
portable_root="$(cd "$requested_root" && pwd -P)"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'The pinned LM Studio app requires Apple Silicon macOS.' >&2
  exit 1
fi
source "$portable_source/versions.sh"
source "$portable_source/download.sh"
umask 077
mkdir -p "$portable_root/cache/downloads" "$portable_root/apps/darwin-arm64" "$portable_root/models"
if ! mkdir "$portable_root/.local-ai-setup-lock" 2>/dev/null; then
  echo 'Another local AI setup is running (or left .local-ai-setup-lock after interruption).' >&2
  exit 1
fi
mount=''
cleanup() {
  if [ -n "$mount" ]; then /usr/bin/hdiutil detach "$mount" >/dev/null || true; fi
  rmdir "$portable_root/.local-ai-setup-lock"
}
trap cleanup EXIT
archive="$portable_root/cache/downloads/LM-Studio-$LM_STUDIO_VERSION-arm64.dmg"
download "https://installers.lmstudio.ai/darwin/arm64/$LM_STUDIO_VERSION/LM-Studio-$LM_STUDIO_VERSION-arm64.dmg" "$archive" "$LM_STUDIO_SHA256"
app_parent="$portable_root/apps/darwin-arm64/lm-studio-$LM_STUDIO_VERSION"
app="$app_parent/LM Studio.app"
if [ ! -d "$app" ]; then
  mount="$(mktemp -d /private/tmp/copse-lmstudio.XXXXXX)"
  /usr/bin/hdiutil attach "$archive" -nobrowse -readonly -mountpoint "$mount" >/dev/null
  /usr/bin/codesign --verify --deep --strict -R='anchor apple generic and certificate leaf[subject.OU] = "D65G88RHWN"' "$mount/LM Studio.app"
  mkdir -p "$app_parent"
  /usr/bin/ditto "$mount/LM Studio.app" "$app"
  /usr/bin/hdiutil detach "$mount" >/dev/null
  rmdir "$mount"
  mount=''
fi
/usr/bin/codesign --verify --deep --strict -R='anchor apple generic and certificate leaf[subject.OU] = "D65G88RHWN"' "$app"
installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
if [ "$installed_version" != "${LM_STUDIO_VERSION/-/+}" ]; then
  echo "Installed LM Studio is $installed_version; expected ${LM_STUDIO_VERSION/-/+}. Quit it, remove $app_parent, and rerun this installer to restore the pinned app." >&2
  exit 1
fi
while IFS=$'\t' read -r repository revision filename checksum bytes minimum_memory tier; do
  folder="$portable_root/models/$repository"
  mkdir -p "$folder"
  echo "Preparing $filename ($bytes bytes; $tier tier, recommended for $minimum_memory GiB RAM or more)"
  download "https://huggingface.co/$repository/resolve/$revision/$filename" "$folder/$filename" "$checksum"
done < "$portable_source/models.tsv"
cp "$portable_source/models.tsv" "$portable_root/models/models.tsv"
echo "LM Studio installed: $app"
echo "Model library: $portable_root/models"
echo 'The GUI refuses to run directly from external storage. Use make portable-lm-studio for offline installation into /Applications and launch.'
echo 'LM Studio keeps its own per-user profile. This installer does not change the host profile or model-library selection.'
