#!/bin/sh
# Train on this Mac's GPU inside Copse's own sandbox profile (ASRT) plus Apple GPU access: no
# network, home unreadable except this checkout and the Python store the venv links to, and writes
# only to the run's output directory. See sandbox-profile.mjs for the one addition to ASRT.
#
#   benchmarks/risk-classifier/host-train.sh <run-name> [train.py args...]
#   benchmarks/risk-classifier/host-train.sh --probe      # prove the sandbox holds and the GPU works
#   benchmarks/risk-classifier/host-train.sh --export-veto [--split dev]   # export_veto.py, sandboxed
#   benchmarks/risk-classifier/host-train.sh --family-holdout              # family_holdout.py, sandboxed
#   benchmarks/risk-classifier/host-train.sh --adversarial [--models …]    # adversarial_finetune.py
#
# Set up the venv once, outside the sandbox (it needs the network):
#   uv venv --python 3.12 bench-results/risk-classifier/host-venv
#   VIRTUAL_ENV=bench-results/risk-classifier/host-venv \
#     uv pip install --require-hashes -r benchmarks/risk-classifier/requirements-host.txt
# Model checkpoints come from bench-results/risk-classifier/hf-cache, filled by the container step.
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd -P)
base="$repo/bench-results/risk-classifier"
venv="$base/host-venv"
python="$venv/bin/python"
[ -x "$python" ] || { echo "missing $venv; see the header of this script" >&2; exit 2; }
# uv links the venv to a version alias inside its Python store; allow the store, which holds only
# Python installs.
python_store=$(cd "$(dirname "$(readlink -f "$python")")/../.." && pwd -P)

name=${1:?usage: host-train.sh <run-name>|--probe [train.py args...]}
shift
case $name in
--probe) out="$base/out/probe" ;;
--export-veto) out="$base/out/export-veto" ;;
--family-holdout) out="$base/out/family-holdout" ;;
--adversarial) out="$base/out/adversarial" ;;
*) out="$base/out/$name" ;;
esac
mkdir -p "$out"
profile="$out/sandbox.sb"
# Metal compiles kernels through per-user library and module caches and MPSGraph keeps its own;
# none can be moved, so those three cache directories are writable too. They hold compiler output, not
# credentials, but they are shared with other Metal programs: that is the one write outside $out.
metal_cache=$(cd "$(getconf DARWIN_USER_CACHE_DIR)" && pwd -P)/
node "$repo/benchmarks/risk-classifier/sandbox-profile.mjs" --deny-read "$HOME" \
  --allow-read "$repo" --allow-read "$python_store" --allow-write "$out" \
  --allow-write "${metal_cache}com.apple.metal" --allow-write "${metal_cache}com.apple.metalfe" \
  --allow-write "${metal_cache}com.apple.MetalPerformanceShadersGraph" >"$profile"

run() {
  env HF_HOME="$base/hf-cache" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 \
    TMPDIR="$out" /usr/bin/sandbox-exec -f "$profile" "$python" -I -B "$@"
}

if [ "$name" = "--probe" ]; then
  cat >"$out/probe.py" <<'PY'
import os, socket, urllib.request, torch
def blocked(what, fn):
    try:
        fn(); print(f"FAIL  {what} succeeded"); return False
    except Exception as e:
        print(f"ok    {what} blocked ({type(e).__name__})"); return True
results = [
    blocked("HTTPS to huggingface.co", lambda: urllib.request.urlopen("https://huggingface.co", timeout=5)),
    blocked("raw TCP to 1.1.1.1:443", lambda: socket.create_connection(("1.1.1.1", 443), timeout=5)),
    blocked("read ~/.ssh", lambda: os.listdir(os.path.expanduser("~/.ssh"))),
    blocked("read ~/.copse", lambda: os.listdir(os.path.expanduser("~/.copse"))),
    blocked("write outside the output dir", lambda: open(os.path.expanduser("~/risk-probe.txt"), "w")),
]
mps = torch.backends.mps.is_available() and torch.ones(4, device="mps").sum().item() == 4
print(("ok    " if mps else "FAIL  ") + "Apple GPU (MPS) usable inside the sandbox")
raise SystemExit(0 if all(results) and mps else 1)
PY
  run "$out/probe.py"
  exit
fi

if [ "$name" = "--adversarial" ]; then
  run "$repo/benchmarks/risk-classifier/adversarial_finetune.py" --repo "$repo" \
    --private "$base/data/private-labelled.jsonl" --adversarial "$base/data/adversarial.jsonl" "$@"
  exit
fi

if [ "$name" = "--family-holdout" ]; then
  run "$repo/benchmarks/risk-classifier/family_holdout.py" --repo "$repo" \
    --private "$base/data/private-labelled.jsonl" --redteam "$base/data/redteam.jsonl" "$@"
  exit
fi

if [ "$name" = "--export-veto" ]; then
  run "$repo/benchmarks/risk-classifier/export_veto.py" --repo "$repo" --out "$out/ask-veto-model.json" \
    --private "$base/data/private-labelled.jsonl" "$@"
  exit
fi

run "$repo/benchmarks/risk-classifier/train.py" --repo "$repo" --hf "$base/data/hf" \
  --private "$base/data/private-labelled.jsonl" --out "$out" "$@"
