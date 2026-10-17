#!/usr/bin/env bash
# Emit the API-verified evidence for the exact release SHA. 75 means pending;
# every other nonzero exit is a hard failure. Never trust a check name alone.
set -euo pipefail
sha="${1:?release commit required}"
run_id="${2:-}"
repo="${GITHUB_REPOSITORY:?repository required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release SHA' >&2; exit 1; }
if [ -z "$run_id" ]; then
  runs="$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&per_page=100")"
  run_id="$(jq -er '.workflow_runs | sort_by(.run_number) | last | .id // empty' <<< "$runs")" || exit 75
fi
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid CI run ID' >&2; exit 1; }
run="$(gh api "repos/$repo/actions/runs/$run_id")"
jq -e --arg sha "$sha" --arg repo "$repo" '
  .path == ".github/workflows/ci.yml" and .event == "push" and
  .head_sha == $sha and .repository.full_name == $repo and
  .head_repository.full_name == $repo and
  (.run_attempt | type == "number" and . > 0)
' <<< "$run" >/dev/null || { echo 'CI provenance does not match release' >&2; exit 1; }
attempt="$(jq -r .run_attempt <<< "$run")"
# Pin one attempt; pagination must not omit the aggregate behind shard jobs.
jobs="$(gh api --paginate --slurp "repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100")"
gate="$(jq -c '[.[].jobs[] | select(.name == "Full release validation")]' <<< "$jobs")"
count="$(jq length <<< "$gate")"
if [ "$count" = 0 ]; then
  [ "$(jq -r .status <<< "$run")" != completed ] && exit 75
  echo 'Completed CI has no full release validation gate' >&2
  exit 1
fi
[ "$count" = 1 ] || { echo 'Ambiguous full release validation gate' >&2; exit 1; }
[ "$(jq -r '.[0].status' <<< "$gate")" = completed ] || exit 75
jq -e --arg sha "$sha" '.[0] | .conclusion == "success" and .head_sha == $sha' <<< "$gate" >/dev/null || {
  echo 'Full release validation failed, skipped, cancelled, or has the wrong SHA' >&2
  exit 1
}
[ "$(jq -r .status <<< "$run")" = completed ] || exit 75
[ "$(jq -r .conclusion <<< "$run")" = success ] || { echo 'CI run did not succeed' >&2; exit 1; }
# Stable record: survives Actions retention as a checksummed public release asset.
jq -n --arg sha "$sha" --arg repo "$repo" --argjson run "$run" --argjson gate "$gate" '{
  schema_version: 1, repository: $repo, release_sha: $sha,
  ci_run_id: $run.id, ci_run_attempt: $run.run_attempt,
  ci_url: $run.html_url, workflow: $run.path,
  e2e_mode: "full", unit_mode: "full", e2e_shards: 8,
  validation_job_id: $gate[0].id, validation_completed_at: $gate[0].completed_at
}'
