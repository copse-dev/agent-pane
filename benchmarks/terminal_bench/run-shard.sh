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
benchmark_status=0
analysis_status=0
steered_status=0
checkpoint_script="benchmarks/terminal_bench/checkpoint-results.sh"
suite_args=(
  --max-tasks="${COPSE_TERMINAL_MAX_TASKS}"
  --shard-count="${COPSE_TERMINAL_SHARD_COUNT}"
  --shard-index="${COPSE_TERMINAL_SHARD_INDEX}"
  --profiles="$profiles_csv"
  --checkpoint-after-task
  --prefetch-images
  --prune-images
  -k "${COPSE_TERMINAL_ATTEMPTS}"
)
if [[ -n "${COPSE_TERMINAL_TASK_NAMES:-}" ]]; then
  suite_args+=(--task-names="${COPSE_TERMINAL_TASK_NAMES}")
fi
echo "terminal-bench worker: task-major profiles ${profiles_csv}; attempts=${COPSE_TERMINAL_ATTEMPTS}"
npm run bench:terminal:suite -- "${suite_args[@]}" || benchmark_status=$?

if [[ -n "${BENCH_ANALYST_MODEL:-}" ]]; then
  npm run bench:terminal:analyze || analysis_status=$?
  if [[ "${COPSE_TERMINAL_STEERED_RERUN:-1}" == "1" && "$analysis_status" == "0" ]]; then
    npm run bench:terminal:steered || steered_status=$?
  fi
  bash "$checkpoint_script" "analysis" || analysis_status=$?
fi

if (( benchmark_status != 0 || analysis_status != 0 || steered_status != 0 )); then
  echo "terminal-bench worker: benchmark=$benchmark_status analysis=$analysis_status steered=$steered_status" >&2
  exit 1
fi

echo "terminal-bench worker: shard ${COPSE_TERMINAL_SHARD_INDEX}/${COPSE_TERMINAL_SHARD_COUNT} complete"
