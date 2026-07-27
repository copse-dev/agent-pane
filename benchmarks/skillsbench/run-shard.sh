#!/usr/bin/env bash
set -uo pipefail

oracle_mode="${COPSE_SKILLSBENCH_ORACLE:-false}"

required=(
  COPSE_BENCH_RUN_ID
  COPSE_SKILLSBENCH_TASK_NAMES
  COPSE_SKILLSBENCH_SHARD_COUNT
  COPSE_SKILLSBENCH_SHARD_INDEX
  SCW_OBJECT_STORAGE_BUCKET
  SCW_OBJECT_STORAGE_ENDPOINT
  SCW_OBJECT_STORAGE_PREFIX
)
# The oracle runs the task's own solution: no model, no profile, no agent bundle.
if [[ "$oracle_mode" != true ]]; then
  required+=(
    LM_STUDIO_URL
    LM_STUDIO_MODEL
    LM_STUDIO_API_KEY
    COPSE_SKILLSBENCH_PROFILE
    COPSE_SKILLSBENCH_ATTEMPTS
  )
fi
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "skillsbench worker: missing $name" >&2
    exit 2
  fi
done

args=(
  --task-names "$COPSE_SKILLSBENCH_TASK_NAMES"
  --shard-count "$COPSE_SKILLSBENCH_SHARD_COUNT"
  --shard-index "$COPSE_SKILLSBENCH_SHARD_INDEX"
)
if [[ "$oracle_mode" == true ]]; then
  args+=(--oracle)
else
  args+=(
    --profiles "${COPSE_SKILLSBENCH_PROFILES:-$COPSE_SKILLSBENCH_PROFILE}"
    --attempts "$COPSE_SKILLSBENCH_ATTEMPTS"
  )
fi

run_status=0
upload_status=0
python benchmarks/skillsbench/run_spike.py "${args[@]}" || run_status=$?

if [[ -d bench-results/skillsbench-capsules ]]; then
  aws s3 cp bench-results/skillsbench-capsules/ \
    "s3://${SCW_OBJECT_STORAGE_BUCKET}/${SCW_OBJECT_STORAGE_PREFIX}/" \
    --recursive \
    --sse AES256 \
    --only-show-errors \
    --endpoint-url "$SCW_OBJECT_STORAGE_ENDPOINT" || upload_status=$?
else
  echo "skillsbench worker: capsule directory was not created" >&2
  upload_status=1
fi

if (( run_status != 0 || upload_status != 0 )); then
  echo "skillsbench worker: run=$run_status upload=$upload_status" >&2
  exit 1
fi

echo "skillsbench worker: shard ${COPSE_SKILLSBENCH_SHARD_INDEX}/${COPSE_SKILLSBENCH_SHARD_COUNT} complete"
