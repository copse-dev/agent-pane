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

# Every check needs a real answer from GitHub. A request that fails (DNS,
# outage, timeout) is "not confirmed", never "absent", so an unreachable host
# cannot pass for a halted release.
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# Print the HTTP status of a signed-out GET ("000" when no response arrived);
# the body is left in "$body". No credentials: the check must see exactly
# what an installed app sees.
get() {
  curl -sSL --max-time 60 -o "$body" -w '%{http_code}' "$@" 2>/dev/null || true
}

# 0 with the tag GitHub calls latest on stdout (empty when no stable release
# exists yet); 1 when GitHub gave no usable answer.
latest_tag() {
  case "$(get -H 'Accept: application/json' "$base/releases/latest")" in
    200) jq -er '.tag_name' "$body" 2>/dev/null ;;
    404) echo '' ;;
    *) return 1 ;;
  esac
}

# 0 listed, 1 not listed, 2 no usable answer.
atom_lists_tag() {
  [ "$(get "$base/releases.atom")" = 200 ] || return 2
  grep -qF "/releases/tag/$tag\"" "$body" || return 1
}

check() {
  local latest listed=0
  case "$state" in
    promoted)
      latest="$(latest_tag)" && [ "$latest" = "$tag" ] || return 1
      [ "$(get "$base/releases/download/$tag/latest-mac.yml")" = 200 ] &&
        grep -qx "version: $version" "$body"
      ;;
    halted)
      latest="$(latest_tag)" && [ "$latest" != "$tag" ] || return 1
      atom_lists_tag || listed=$?
      [ "$listed" = 1 ] || return 1
      [ "$(get "$base/releases/download/$tag/SHA256SUMS")" = 404 ]
      ;;
    listed)
      atom_lists_tag
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
