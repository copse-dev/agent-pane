#!/usr/bin/env bash
# Preserve the binary repository's exact Git object while withdrawing a halted
# version from releases.atom. Source tags and release assets are never changed.
set -euo pipefail
repository="${1:?release repository required}"
tag="${2:?release tag required}"
action="${3:?archive, withdraw, restore or verify-restored required}"
case "$tag" in
  v*) node scripts/release-channel.mts --release-type "${tag#v}" > /dev/null ;;
  *) echo 'Release tag must start with v' >&2; exit 1 ;;
esac
case "$action" in
  archive|withdraw|restore|verify-restored) ;;
  *) echo 'Expected archive, withdraw, restore or verify-restored' >&2; exit 1 ;;
esac

read_ref() {
  local value
  if ! value="$(gh api "repos/$repository/git/ref/tags/$1" --jq .object.sha 2>&1)"; then
    case "$value" in
      *"HTTP 404"*) echo ''; return ;;
      *) echo "Could not read tag $1: $value" >&2; return 1 ;;
    esac
  fi
  if [[ ! "$value" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Invalid Git object for tag $1" >&2
    return 1
  fi
  echo "$value"
}

original="$(read_ref "$tag")"
archived="$(read_ref "halted/$tag")"
if [ -n "$original" ] && [ -n "$archived" ] && [ "$original" != "$archived" ]; then
  echo "Refusing to change $tag: its Git object differs from halted/$tag" >&2
  exit 1
fi

case "$action" in
  archive)
    if [ -z "$archived" ]; then
      [ -n "$original" ] || { echo "No Git object to preserve for $tag" >&2; exit 1; }
      gh api --method POST "repos/$repository/git/refs" \
        -f "ref=refs/tags/halted/$tag" -f "sha=$original" > /dev/null
    fi
    ;;
  withdraw)
    [ -n "$archived" ] || { echo "No archived Git object for $tag" >&2; exit 1; }
    if [ -n "$original" ]; then
      gh api --method DELETE "repos/$repository/git/refs/tags/$tag"
    fi
    ;;
  restore)
    if [ -z "$original" ]; then
      [ -n "$archived" ] || { echo "No archived Git object for $tag" >&2; exit 1; }
      gh api --method POST "repos/$repository/git/refs" \
        -f "ref=refs/tags/$tag" -f "sha=$archived" > /dev/null
    elif [ -z "$archived" ]; then
      # Legacy halts kept the original tag. Preserve it before publication too,
      # so a partial resume can prove its provenance without republishing.
      gh api --method POST "repos/$repository/git/refs" \
        -f "ref=refs/tags/halted/$tag" -f "sha=$original" > /dev/null
    fi
    ;;
  verify-restored)
    # read_ref and the shared conflict check above already verified both SHAs.
    [ -n "$original" ] && [ -n "$archived" ] || {
      echo "$tag is not a restored halted release" >&2
      exit 1
    }
    ;;
esac
