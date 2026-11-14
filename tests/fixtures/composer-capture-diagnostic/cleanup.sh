#!/usr/bin/env bash
# Same ephemeral hosted-runner janitor as ci.yml; never run on a developer host.
set -euo pipefail
if [[ ${GITHUB_ACTIONS:-} != true || ${DIAGNOSTIC_RUNNER_ENVIRONMENT:-} != github-hosted || ${RUNNER_OS:-} != Linux || ${RUNNER_ARCH:-} != X64 || ${GITHUB_JOB:-} != composer-canonical-pair || ${GITHUB_REF:-} != refs/heads/codex/composer-canonical-diagnostic-20261114 || ${GITHUB_RUN_ATTEMPT:-} != 1 ]]; then
  echo 'Refusing hosted-only diagnostic cleanup outside its isolated Actions job' >&2
  exit 64
fi
E2E_SOCAT_PATTERN='[s]ocat.*claude-(http|socks)-[0-9a-f]+\.sock'
for signal in TERM KILL; do
  pkill -"$signal" -f '[e]lectron/dist/electron' 2>/dev/null || true
  pkill -"$signal" -f '[e]lectron-chromedriver/bin/chromedriver' 2>/dev/null || true
  pkill -"$signal" -f '[X]vfb' 2>/dev/null || true
  pkill -"$signal" -f '[g]ortex' 2>/dev/null || true
  pkill -"$signal" -f "$E2E_SOCAT_PATTERN" 2>/dev/null || true
  if [[ $signal == TERM ]]; then sleep 1; fi
done
for pattern in '[e]lectron/dist/electron' '[e]lectron-chromedriver/bin/chromedriver' '[X]vfb' '[g]ortex' "$E2E_SOCAT_PATTERN"; do
  if pgrep -f "$pattern"; then
    echo 'Diagnostic process remains after normal CI janitor' >&2
    exit 1
  else
    result=$?
    if [[ $result != 1 ]]; then exit "$result"; fi
  fi
done
find "${TMPDIR:-/tmp}" -maxdepth 1 \
  \( -name 'claude-http-*.sock' -o -name 'claude-socks-*.sock' \) \
  -delete 2>/dev/null || true
