#!/usr/bin/env bash
set -uo pipefail

# One-shot e2e run inside a copse-ci-runner container, driven by the remote
# e2e dev-loop CLI (scripts/remote-e2e.mts — see docs/plans/remote-e2e-dev-loop.md).
# Not used by the GitHub Actions runner flow at all: the CLI uploads this file
# to the host at /srv/remote-e2e/exec-run.sh during `e2e:remote up`, then each
# `e2e:remote run` starts a fresh container with
#
#   docker run --rm --init --entrypoint bash \
#     -v /srv/remote-e2e:/srv/remote-e2e copse-ci-runner:latest \
#     /srv/remote-e2e/exec-run.sh <run-id> <sha> [wdio args…]
#
# so every run gets a pristine container (the same isolation the ephemeral CI
# runners get per job). The host directory carries everything in and out:
#
#   /srv/remote-e2e/repo.git            bare repo the local CLI pushes
#                                       snapshot commits into (refs/runs/<id>)
#   /srv/remote-e2e/runs/<run-id>/      this run's workspace + results:
#     tree/                             checkout of <sha> (removed on exit
#                                       unless KEEP_TREE=1)
#     log                               full run output (also streamed)
#     status                            final exit code — its existence is the
#                                       "run finished" signal the CLI polls
#     artifacts.tar.gz                  wdio logs + changed reference
#                                       screenshots vs the snapshot commit
#
# Exit code mirrors the e2e result so an attached (foreground) run propagates
# failures through docker → ssh → the local CLI.

if [[ $# -lt 2 ]]; then
  echo "usage: exec-run.sh <run-id> <sha> [wdio args…]" >&2
  exit 2
fi

BASE=/srv/remote-e2e
RUN_ID="$1"
SHA="$2"
shift 2
RUN_DIR="${BASE}/runs/${RUN_ID}"
TREE="${RUN_DIR}/tree"

mkdir -p "${RUN_DIR}"
# Persist everything we print, while still streaming to the attached client.
exec > >(tee -a "${RUN_DIR}/log") 2>&1

# Safety net: the local CLI polls for the status file, so it must appear even
# when this script dies abruptly (docker stop's SIGTERM, an unhandled error)
# instead of reaching finish(). finish() sets FINISHED before its own status
# write, making this trap a no-op on the normal path.
FINISHED=0
on_exit() {
  local code=$?
  if [[ "${FINISHED}" != "1" ]]; then
    echo "==> aborted before completion (signal or unhandled error)" || true
    [[ -f "${RUN_DIR}/status" ]] || echo "${code:-1}" > "${RUN_DIR}/status" 2>/dev/null || true
  fi
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

finish() {
  local code="$1"
  # Collect artifacts even on failure — failures are when you want the logs.
  # Mirrors the CI "Collect changed reference screenshots" step: diffs vs the
  # snapshot commit plus untracked PNGs (first-time reference shots).
  local staging="${RUN_DIR}/artifacts"
  mkdir -p "${staging}/tests/e2e/screenshots"
  {
    echo "run=${RUN_ID}"
    echo "sha=${SHA}"
    echo "exit=${code}"
  } > "${staging}/run-info.txt"
  if cd "${TREE}" 2>/dev/null; then
    mapfile -t shots < <(
      {
        git diff --name-only -- tests/e2e/screenshots/
        git ls-files --others --exclude-standard -- tests/e2e/screenshots/
      } 2>/dev/null | sort -u
    )
    for f in "${shots[@]}"; do
      [[ -n "${f}" && -f "${f}" ]] || continue
      cp "${f}" "${staging}/tests/e2e/screenshots/"
    done
    echo "==> collected ${#shots[@]} changed screenshot(s)"
    cd /
  fi
  tar -C "${RUN_DIR}" -czf "${RUN_DIR}/artifacts.tar.gz" artifacts
  rm -rf "${staging}"
  if [[ "${KEEP_TREE:-0}" != "1" ]]; then
    rm -rf "${TREE}"
  fi
  # Written last: the local CLI treats this file's existence as run completion.
  # FINISHED only flips once the write landed, so the EXIT trap still retries
  # the status write if this one fails.
  echo "${code}" > "${RUN_DIR}/status" && FINISHED=1
  exit "${code}"
}

echo "==> remote-e2e run ${RUN_ID} @ ${SHA} ($*)"

# --shared: object store via alternates into the bind-mounted bare repo — no
# object copy, and the snapshot sha is reachable without fetching its ref.
if ! git clone --quiet --shared --no-checkout "${BASE}/repo.git" "${TREE}"; then
  echo "ERROR: could not clone ${BASE}/repo.git" >&2
  finish 1
fi
cd "${TREE}"
if ! git checkout --quiet --detach "${SHA}"; then
  echo "ERROR: snapshot ${SHA} not found in ${BASE}/repo.git — was the push interrupted?" >&2
  finish 1
fi

# Seed dependencies from the image's baked layer when the lockfile still
# matches (same contract as .github/actions/setup). On drift, fall back to
# npm ci — which needs network and, for the private @copse/streaming-markdown
# git dep, a token this container deliberately does not have. Rebake instead:
#   npm run e2e:remote -- rebake
seeded=false
if [[ -n "${COPSE_BAKED_DEPS:-}" && -f "${COPSE_BAKED_DEPS}/.ready" ]]; then
  want="$(sha256sum package-lock.json 2>/dev/null | awk '{ print $1 }' || echo want)"
  have="$(cat "${COPSE_BAKED_DEPS}/.lockhash" 2>/dev/null || echo have)"
  if [[ "${want}" == "${have}" ]]; then
    if cp -a "${COPSE_BAKED_DEPS}/node_modules" node_modules \
       && { [[ ! -d "${COPSE_BAKED_DEPS}/vendor/gortex" ]] \
            || { mkdir -p vendor && cp -a "${COPSE_BAKED_DEPS}/vendor/gortex" vendor/gortex; }; }; then
      seeded=true
      echo "==> seeded node_modules from baked deps"
    else
      rm -rf node_modules
    fi
  else
    echo "WARNING: package-lock.json differs from the baked layer — falling back to npm ci." >&2
    echo "         This is slow and fails for the private git dep without a token;" >&2
    echo "         rebake the host image instead: npm run e2e:remote -- rebake" >&2
  fi
fi
if [[ "${seeded}" != "true" ]]; then
  if ! npm ci --include=optional --no-audit --no-fund; then
    echo "ERROR: npm ci fallback failed (lockfile drift + no clone token in this container)" >&2
    finish 1
  fi
fi

echo "==> building dist/"
if ! node scripts/build.mts; then
  echo "ERROR: build failed" >&2
  finish 1
fi

# Same retry shape as the CI e2e shard step: the Electron/Chromedriver session
# occasionally wedges on startup and only a fresh xvfb+Electron launch
# recovers, so cap each attempt with `timeout` and retry the whole run.
TIMEOUT="$(command -v timeout || true)"
for attempt in 1 2 3; do
  echo "==> e2e attempt ${attempt}: npm run test:e2e:ci -- $*"
  if ${TIMEOUT:+${TIMEOUT} -k 15 480} npm run test:e2e:ci -- "$@"; then
    finish 0
  fi
  echo "==> attempt ${attempt} failed or timed out"
done
finish 1
