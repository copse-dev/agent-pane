#!/usr/bin/env bash
# Create GitHub issues from .github/issue-drafts/*.md
# Requires: gh CLI authenticated with issue create permission on copse-dev/agent-pane
set -euo pipefail

REPO="${REPO:-copse-dev/agent-pane}"
DRAFTS_DIR="$(cd "$(dirname "$0")/../.github/issue-drafts" && pwd)"

declare -A TITLES=(
  ["01-per-thread-worktrees.md"]="Per-thread git worktrees for parallel agent threads"
  ["02-knowledge-surfacing.md"]="Knowledge surfacing: inject relevant notes at prompt time"
  ["03-doc-knowledge-type.md"]="Doc knowledge type: auto-generated repository architecture notes"
  ["04-pr-review-pane.md"]="PR review pane: grouped diffs, findings, and chat-on-PR"
  ["05-agent-pr-shipping.md"]="Agent PR shipping: guarded git push and CI feedback loop"
  ["06-playbooks-knowledge.md"]="Playbooks as typed knowledge notes with session attach"
  ["07-cloud-runner-design.md"]="Cloud agent runner architecture (design)"
)

for file in "${!TITLES[@]}"; do
  path="$DRAFTS_DIR/$file"
  if [[ ! -f "$path" ]]; then
    echo "missing draft: $path" >&2
    exit 1
  fi
  title="${TITLES[$file]}"
  echo "Creating: $title"
  gh issue create --repo "$REPO" --title "$title" --body-file "$path"
done

echo "Done. Created ${#TITLES[@]} issues."
