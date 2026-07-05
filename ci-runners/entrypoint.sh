#!/usr/bin/env bash
set -euo pipefail

# Registers this container as a GitHub Actions self-hosted runner, runs jobs,
# and (when ephemeral) deregisters cleanly on exit. Identical registration flow
# to agent-pane's .github/runner*/entrypoint.sh — the ONLY change is the default
# label set, which now advertises BOTH tiers (copse-e2e + copse-checks) so a
# single unified fleet serves e2e and check jobs alike.
#
# Repo OR org scope: GITHUB_URL may be a repo URL
# (https://github.com/<owner>/<repo>) or an org URL (https://github.com/<owner>).
# registration_token_url() picks the matching REST endpoint automatically, so
# the same image registers an org-shared pool with no code change — just point
# GITHUB_URL at the org and give ACCESS_TOKEN org-level runner admin.
#
# Required env:
#   GITHUB_URL    Repo URL   https://github.com/<owner>/<repo>
#                 or org URL  https://github.com/<owner>
#
# Auth — provide exactly ONE:
#   ACCESS_TOKEN  A PAT exchanged for a short-lived registration token on every
#                 start.
#                   repo scope:  classic `repo`, or fine-grained repository
#                                Administration -> Read & write.
#                   org scope:   classic `admin:org` (manage_runners), or
#                                fine-grained organization "Self-hosted runners"
#                                -> Read & write.
#   RUNNER_TOKEN  A pre-fetched registration token (refresh it yourself; expires
#                 in ~1h).
#
# Optional env:
#   RUNNER_NAME    default: docker-<container-hostname>-<pid>
#   RUNNER_LABELS  default: self-hosted,linux,docker,copse-e2e,copse-checks
#   RUNNER_GROUP   default: default
#   EPHEMERAL      "true" (default): take one job, then exit so the orchestrator
#                  restarts a pristine container. "false": long-lived runner.

: "${GITHUB_URL:?set GITHUB_URL to the repo or org URL}"

RUNNER_NAME="${RUNNER_NAME:-docker-$(hostname)-$$}"
# Both labels by default: this unified image can serve either tier. CI targets
# `copse-e2e` for the e2e job and `copse-checks` for the static+unit tier; a
# runner carrying both is eligible for whichever is queued, so the pool
# self-balances instead of splitting into idle/overworked halves.
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,docker,copse-e2e,copse-checks}"
RUNNER_GROUP="${RUNNER_GROUP:-default}"
EPHEMERAL="${EPHEMERAL:-true}"

# REST endpoint for a registration token differs for repo vs org URLs.
registration_token_url() {
  local path="${GITHUB_URL#https://github.com/}"
  path="${path%/}"
  case "$path" in
    */*) echo "https://api.github.com/repos/${path}/actions/runners/registration-token" ;;
    *)   echo "https://api.github.com/orgs/${path}/actions/runners/registration-token" ;;
  esac
}

if [[ -z "${RUNNER_TOKEN:-}" ]]; then
  if [[ -n "${ACCESS_TOKEN:-}" ]]; then
    echo "Requesting a registration token from the GitHub API…"
    RUNNER_TOKEN="$(curl -fsSL -X POST \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$(registration_token_url)" | jq -r .token)"
    if [[ -z "${RUNNER_TOKEN}" || "${RUNNER_TOKEN}" == "null" ]]; then
      echo "ERROR: failed to obtain a registration token — check ACCESS_TOKEN scope and GITHUB_URL." >&2
      exit 1
    fi
  else
    echo "ERROR: set ACCESS_TOKEN (a PAT) or RUNNER_TOKEN (a registration token)." >&2
    exit 1
  fi
fi

# Best-effort deregister on stop. For ephemeral runners GitHub also removes the
# registration automatically after the single job, so this is belt-and-suspenders.
cleanup() {
  echo "Deregistering runner…"
  ./config.sh remove --token "${RUNNER_TOKEN}" || true
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# A container's filesystem survives a `docker restart` / restart-policy bounce
# (the same container is re-run, not recreated), so a prior run's registration
# files can still be here — and config.sh refuses to reconfigure when they are.
# Clear any prior local config first; `--replace` below reclaims the same-named
# server registration.
if [[ -f .runner ]]; then
  echo "Existing runner config found — removing before reconfigure…"
  ./config.sh remove --token "${RUNNER_TOKEN}" 2>/dev/null \
    || rm -f .runner .credentials .credentials_rsaparams
fi

CONFIG_ARGS=(
  --url "${GITHUB_URL}"
  --token "${RUNNER_TOKEN}"
  --name "${RUNNER_NAME}"
  --labels "${RUNNER_LABELS}"
  --runnergroup "${RUNNER_GROUP}"
  --work _work
  --unattended
  --replace
)
[[ "${EPHEMERAL}" == "true" ]] && CONFIG_ARGS+=(--ephemeral)

./config.sh "${CONFIG_ARGS[@]}"

# Run in the foreground so the container's lifecycle tracks the runner's. `wait`
# lets the INT/TERM traps fire promptly for a clean deregister + restart.
./run.sh &
wait $!
