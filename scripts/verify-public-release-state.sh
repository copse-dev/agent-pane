#!/usr/bin/env bash
# Check, signed out, what electron-updater sees after a promotion or halt.
# The stable check reads `releases/latest` as JSON; the beta check walks
# `releases.atom`. Both are cached, so poll for up to ten minutes.
#
#   promoted: releases/latest names the tag and its latest-mac.yml is served.
#   halted:   neither releases/latest nor the Atom feed names the tag, and
#             its assets no longer download.
#   listed:   the Atom feed, which the beta check walks, names the tag.
set -euo pipefail
repository="${1:?release repository required}"
tag="${2:?release tag required}"
state="${3:?promoted, halted or listed required}"
base="https://github.com/$repository"
version="${tag#v}"

latest_tag() {
  # No credentials: the check must see exactly what an installed app sees.
  curl -fsSL --max-time 30 -H 'Accept: application/json' "$base/releases/latest" 2>/dev/null |
    jq -r '.tag_name // empty' 2>/dev/null || true
}

# Read whole bodies before matching: `grep -q` closing a pipe early would fail
# curl under pipefail and read as a mismatch.
fetch() {
  curl -fsSL --max-time 60 "$@" 2>/dev/null || true
}

listed_in_atom() {
  [[ "$(fetch "$base/releases.atom")" == *"/releases/tag/$tag\""* ]]
}

check() {
  case "$state" in
    promoted)
      [ "$(latest_tag)" = "$tag" ] || return 1
      [[ $'\n'"$(fetch "$base/releases/download/$tag/latest-mac.yml")" == *$'\n'"version: $version"$'\n'* ]]
      ;;
    halted)
      [ "$(latest_tag)" != "$tag" ] || return 1
      ! listed_in_atom || return 1
      ! curl -fsSL --max-time 30 -o /dev/null "$base/releases/download/$tag/SHA256SUMS"
      ;;
    listed)
      listed_in_atom
      ;;
    *)
      echo "Unknown state $state" >&2
      exit 2
      ;;
  esac
}

for attempt in $(seq 1 20); do
  if check; then
    echo "Anonymous check: $tag is $state (attempt $attempt)."
    exit 0
  fi
  sleep 30
done
echo "::error::After ten minutes an anonymous client still does not see $tag as $state."
exit 1
