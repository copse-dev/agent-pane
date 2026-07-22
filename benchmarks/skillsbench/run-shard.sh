#!/usr/bin/env bash
set -uo pipefail

required=(
  LM_STUDIO_URL
  LM_STUDIO_MODEL
  LM_STUDIO_API_KEY
  COPSE_BENCH_RUN_ID
  COPSE_SKILLSBENCH_TASK_NAMES
  COPSE_SKILLSBENCH_PROFILE
  COPSE_SKILLSBENCH_ATTEMPTS
  COPSE_SKILLSBENCH_SHARD_COUNT
  COPSE_SKILLSBENCH_SHARD_INDEX
  SCW_OBJECT_STORAGE_BUCKET
  SCW_OBJECT_STORAGE_ENDPOINT
  SCW_OBJECT_STORAGE_PREFIX
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "skillsbench worker: missing $name" >&2
    exit 2
  fi
done

run_status=0
upload_status=0
python benchmarks/skillsbench/run_spike.py \
  --profile "$COPSE_SKILLSBENCH_PROFILE" \
  --task-names "$COPSE_SKILLSBENCH_TASK_NAMES" \
  --attempts "$COPSE_SKILLSBENCH_ATTEMPTS" \
  --shard-count "$COPSE_SKILLSBENCH_SHARD_COUNT" \
  --shard-index "$COPSE_SKILLSBENCH_SHARD_INDEX" || run_status=$?

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
