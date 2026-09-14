#!/bin/bash
# An optional, file-complete collection. No host LM Studio settings are imported.
set -euo pipefail
portable_source="$(cd "$(dirname "$0")" && pwd -P)"
if [ "${1:-}" = --offline ]; then
  shift
  exec bash "$portable_source/offline.sh" bash "$portable_source/model-library.sh" "$@"
fi
requested_root="${1:-$portable_source/../../.portable}"
manifest="${2:-$portable_source/collections/extended.tsv}"
source "$portable_source/download.sh"
awk -F '\t' 'NF != 5 || seen[$1 "/" $3]++ { print "Invalid or duplicate model-library row" > "/dev/stderr"; exit 1 }' < "$manifest"

valid_path() {
  case "$1" in ''|/*|*/|*//*|*$'\r'*|*$'\t'*) return 1 ;; esac
  case "/$1/" in */../*|*/./*) return 1 ;; esac
}

# Validate the entire manifest before creating folders or downloading anything.
while IFS=$'\t' read -r repository revision filename checksum bytes extra || [ -n "$repository" ]; do
  if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
     ! valid_path "$repository" || ! valid_path "$filename" ||
     ! [[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
     ! [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] ||
     ! [[ "$bytes" =~ ^[0-9]+$ ]] || [ "$bytes" -le 0 ] || [ -n "$extra" ]; then
    echo "Invalid model-library manifest row: $repository/$filename" >&2
    exit 1
  fi
done < "$manifest"
if [ ! -s "$manifest" ]; then echo 'The model-library manifest is empty.' >&2; exit 1; fi

umask 077
mkdir -p "$requested_root"
portable_root="$(cd "$requested_root" && pwd -P)"
if ! mkdir "$portable_root/.local-ai-setup-lock" 2>/dev/null; then
  echo 'Another local AI setup is running (or left .local-ai-setup-lock after interruption).' >&2
  exit 1
fi
verified="$portable_root/.local-ai-setup-lock/verified.tsv"
touch "$verified"
trap 'rm -f "$verified"; rmdir "$portable_root/.local-ai-setup-lock"' EXIT
while IFS=$'\t' read -r repository revision filename checksum bytes || [ -n "$repository" ]; do
  relative="models/$repository/$filename"
  current="$portable_root"
  # Refuse symlinks in the destination, including existing file and .part names.
  remaining="$relative"
  while [ -n "$remaining" ]; do
    component="${remaining%%/*}"
    current="$current/$component"
    if [ -L "$current" ]; then echo "Model destination is a symlink: $current" >&2; exit 1; fi
    if [ "$remaining" = "$component" ]; then break; fi
    remaining="${remaining#*/}"
  done
  if [ -L "$current.part" ]; then echo "Partial destination is a symlink: $current.part" >&2; exit 1; fi
  mkdir -p "$(dirname "$current")"
  echo "Preparing $repository/$filename ($bytes bytes)"
  matching="$(awk -F '\t' -v checksum="$checksum" '$1 == checksum { print $2; exit }' "$verified")"
  if [ -n "$matching" ]; then
    # Preserve each model's complete folder while sharing identical bytes on APFS.
    /bin/cp -c "$matching" "$current.part" 2>/dev/null || /bin/cp "$matching" "$current.part"
    mv "$current.part" "$current"
  else
    download "https://huggingface.co/$repository/resolve/$revision/$filename" "$current" "$checksum"
    printf '%s\t%s\n' "$checksum" "$current" >> "$verified"
  fi
done < "$manifest"
echo "Verified model library: $portable_root/models"
echo "Manifest: $manifest"
