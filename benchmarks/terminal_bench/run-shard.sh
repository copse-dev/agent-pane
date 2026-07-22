#!/usr/bin/env bash
set -uo pipefail

required=(
  LM_STUDIO_URL
  LM_STUDIO_MODEL
  LM_STUDIO_API_KEY
  COPSE_BENCH_RUN_ID
  COPSE_TERMINAL_MAX_TASKS
  COPSE_TERMINAL_SHARD_COUNT
  COPSE_TERMINAL_SHARD_INDEX
  COPSE_TERMINAL_ATTEMPTS
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

benchmark_status=0
analysis_status=0
steered_status=0
seal_status=0
upload_status=0

npm run bench:terminal:suite -- \
  --max-tasks="${COPSE_TERMINAL_MAX_TASKS}" \
  --shard-count="${COPSE_TERMINAL_SHARD_COUNT}" \
  --shard-index="${COPSE_TERMINAL_SHARD_INDEX}" \
  --prune-images \
  --prefetch-images \
  -k "${COPSE_TERMINAL_ATTEMPTS}" || benchmark_status=$?

if [[ -n "${BENCH_ANALYST_MODEL:-}" ]]; then
  npm run bench:terminal:analyze || analysis_status=$?
  if [[ "${COPSE_TERMINAL_STEERED_RERUN:-1}" == "1" && "$analysis_status" == "0" ]]; then
    npm run bench:terminal:steered || steered_status=$?
  fi
fi

npm run bench:terminal:report || true
npm run bench:terminal:seal || seal_status=$?

if [[ -d bench-results/terminal-bench-capsules ]]; then
  aws s3 cp bench-results/terminal-bench-capsules/ \
    "s3://${SCW_OBJECT_STORAGE_BUCKET}/${SCW_OBJECT_STORAGE_PREFIX}/" \
    --recursive \
    --sse AES256 \
    --only-show-errors \
    --endpoint-url "${SCW_OBJECT_STORAGE_ENDPOINT}" || upload_status=$?
else
  echo "terminal-bench worker: capsule directory was not created" >&2
  upload_status=1
fi

if (( benchmark_status != 0 || analysis_status != 0 || steered_status != 0 || seal_status != 0 || upload_status != 0 )); then
  echo "terminal-bench worker: benchmark=$benchmark_status analysis=$analysis_status steered=$steered_status seal=$seal_status upload=$upload_status" >&2
  exit 1
fi

echo "terminal-bench worker: shard ${COPSE_TERMINAL_SHARD_INDEX}/${COPSE_TERMINAL_SHARD_COUNT} complete"
