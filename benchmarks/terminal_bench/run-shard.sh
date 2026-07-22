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

profiles_csv="${COPSE_TERMINAL_PROFILES:-${COPSE_TERMINAL_PROFILE:-}}"
if [[ -z "$profiles_csv" ]]; then
  echo "terminal-bench worker: missing COPSE_TERMINAL_PROFILES or COPSE_TERMINAL_PROFILE" >&2
  exit 2
fi
IFS=',' read -r -a profiles <<< "$profiles_csv"
profile_count="${#profiles[@]}"

benchmark_status=0
analysis_status=0
steered_status=0
seal_status=0
upload_status=0

for ((profile_offset = 0; profile_offset < profile_count; profile_offset += 1)); do
  profile="${profiles[$profile_offset]}"
  export COPSE_TERMINAL_PROFILE="$profile"
  suite_args=(
    --max-tasks="${COPSE_TERMINAL_MAX_TASKS}"
    --shard-count="${COPSE_TERMINAL_SHARD_COUNT}"
    --shard-index="${COPSE_TERMINAL_SHARD_INDEX}"
    --prefetch-images
    --profile="$profile"
    -k "${COPSE_TERMINAL_ATTEMPTS}"
  )
  if (( profile_offset == profile_count - 1 )); then
    suite_args+=(--prune-images)
  fi
  if [[ -n "${COPSE_TERMINAL_TASK_NAMES:-}" ]]; then
    suite_args+=(--task-names="${COPSE_TERMINAL_TASK_NAMES}")
  fi
  echo "terminal-bench worker: profile $((profile_offset + 1))/${profile_count} $profile"
  npm run bench:terminal:suite -- "${suite_args[@]}" || benchmark_status=$?
done

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
