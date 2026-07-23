#!/usr/bin/env bash
set -uo pipefail

label="${1:-checkpoint}"
required=(
  SCW_OBJECT_STORAGE_BUCKET
  SCW_OBJECT_STORAGE_ENDPOINT
  SCW_OBJECT_STORAGE_PREFIX
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "terminal-bench worker: missing $name" >&2
    exit 2
  fi
done

status=0
npm run bench:terminal:report || true
npm run bench:terminal:seal || status=$?

if [[ -d bench-results/terminal-bench-capsules ]]; then
  aws s3 cp bench-results/terminal-bench-capsules/ \
    "s3://${SCW_OBJECT_STORAGE_BUCKET}/${SCW_OBJECT_STORAGE_PREFIX}/" \
    --recursive \
    --sse AES256 \
    --only-show-errors \
    --endpoint-url "${SCW_OBJECT_STORAGE_ENDPOINT}" || status=$?
else
  echo "terminal-bench worker: capsule directory was not created" >&2
  status=1
fi

if (( status != 0 )); then
  echo "terminal-bench worker: checkpoint failed for ${label}" >&2
  exit "$status"
fi
echo "terminal-bench worker: checkpointed ${label}"
