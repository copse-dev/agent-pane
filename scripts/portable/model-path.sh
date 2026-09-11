#!/bin/bash
# Print a downloaded model path that fits the selected machine's memory tier.
# This does not start LM Studio or modify its active profile.
set -euo pipefail
portable_source="$(cd "$(dirname "$0")" && pwd -P)"
portable_root="$(cd "${1:-$portable_source/../../.portable}" && pwd -P)"
tier="${2:-auto}"
case "$tier" in auto|small|medium|large) ;; *) echo 'Model tier must be auto, small, medium or large.' >&2; exit 1 ;; esac
memory_bytes="$(sysctl -n hw.memsize)"
selected=''
while IFS=$'\t' read -r repository revision filename checksum bytes minimum_memory candidate; do
  if [ "$tier" != auto ] && [ "$tier" != "$candidate" ]; then continue; fi
  if [ "$memory_bytes" -lt "$((minimum_memory * 1024 * 1024 * 1024))" ]; then
    if [ "$tier" != auto ]; then
      echo "$filename requires the $minimum_memory GiB memory tier; select a smaller model on this Mac." >&2
      exit 1
    fi
    continue
  fi
  path="$portable_root/models/$repository/$filename"
  if [ -f "$path" ]; then selected="$path"; fi
done < "$portable_source/models.tsv"
if [ -z "$selected" ]; then
  echo 'No downloaded model matches this memory tier. Run make portable-local-ai-setup first.' >&2
  exit 1
fi
printf '%s\n' "$selected"
