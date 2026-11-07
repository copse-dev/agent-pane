#!/usr/bin/env bash
# Commit LATEST.md to the binary repository's main branch, so it names what the
# public channels serve after a promotion or halt. Release tags keep pointing
# at their own publication commits. GH_TOKEN must write the repository.
set -euo pipefail
repository="${1:?release repository required}"
body="${2:?LATEST.md content file required}"
message="${3:?commit message required}"
path=LATEST.md
# Only a confirmed 404 means the file is new; any other failure stops.
if ! current="$(gh api "repos/$repository/contents/$path?ref=main" --jq .sha 2>&1)"; then
  case "$current" in
    *"HTTP 404"*) current='' ;;
    *)
      echo "::error::Could not read $path in $repository: $current"
      exit 1
      ;;
  esac
fi
args=(
  --method PUT "repos/$repository/contents/$path"
  -f message="$message"
  -f branch=main
  -f content="$(base64 < "$body" | tr -d '\n')"
)
if [ -n "$current" ]; then args+=(-f sha="$current"); fi
gh api "${args[@]}" --jq .commit.sha
