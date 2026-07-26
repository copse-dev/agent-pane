#!/usr/bin/env bash
set -uo pipefail

label="${1:-checkpoint}"
required=(
  COPSE_TERMINAL_RESULTS_ROOT
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

capsules_dir="${COPSE_TERMINAL_RESULTS_ROOT}/terminal-bench-capsules"
upload_receipts="$capsules_dir/.uploaded-capsules.tsv"
if [[ -d "$capsules_dir" ]]; then
  pending_uploads="$(mktemp)"
  if node scripts/list-terminal-bench-pending-capsules.mts \
    "$capsules_dir/index.json" "$upload_receipts" > "$pending_uploads"; then
    while IFS=$'\t' read -r sha256 archive; do
      [[ -z "$archive" ]] && continue
      if aws s3 cp "$capsules_dir/$archive" \
        "s3://${SCW_OBJECT_STORAGE_BUCKET}/${SCW_OBJECT_STORAGE_PREFIX}/$archive" \
        --sse AES256 \
        --only-show-errors \
        --endpoint-url "${SCW_OBJECT_STORAGE_ENDPOINT}"; then
        printf '%s\t%s\n' "$sha256" "$archive" >> "$upload_receipts" || status=$?
      else
        status=$?
      fi
    done < "$pending_uploads"
  else
    status=$?
  fi
  rm -f "$pending_uploads"
  if (( status == 0 )); then
    aws s3 cp "$capsules_dir/" \
      "s3://${SCW_OBJECT_STORAGE_BUCKET}/${SCW_OBJECT_STORAGE_PREFIX}/" \
      --recursive \
      --exclude '*.tar.gz' \
      --exclude '.uploaded-capsules.tsv' \
      --sse AES256 \
      --only-show-errors \
      --endpoint-url "${SCW_OBJECT_STORAGE_ENDPOINT}" || status=$?
  fi
else
  echo "terminal-bench worker: capsule directory was not created" >&2
  status=1
fi

metrics_path="${COPSE_TERMINAL_RESULTS_ROOT}/terminal-bench-host-metrics.jsonl"
if [[ -f "$metrics_path" ]]; then
  aws s3 cp "$metrics_path" \
    "s3://${SCW_OBJECT_STORAGE_BUCKET}/${SCW_OBJECT_STORAGE_PREFIX}/host-metrics.jsonl" \
    --sse AES256 \
    --only-show-errors \
    --endpoint-url "${SCW_OBJECT_STORAGE_ENDPOINT}" || status=$?
fi

if (( status != 0 )); then
  echo "terminal-bench worker: checkpoint failed for ${label}" >&2
  exit "$status"
fi
echo "terminal-bench worker: checkpointed ${label}"
