"""Run frozen Copse inputs with the pinned official SemIf direct scorer.

The model process never reads scoring-manifest.json or any expected labels.
Setup/runtime failures remain failures; over-limit inputs remain explicit errors.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

ROOT = Path(os.environ.get('COPSE_SEMIF_ASSETS', 'bench-results/semif-assets')).resolve()
SOURCE_REVISION = "1f2dea3e25379f9dfc98cb83c324f00ab5deda37"
MODEL = "Qwen/Qwen3.5-4B"
REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"


def check_result(result, row):
    ids = [option["id"] for option in row["options"]]
    if result["id"] != row["id"] or result["option_ids"] != ids:
        raise ValueError("SemIf response ID or option order mismatch")
    probabilities = result["probabilities"]
    if len(probabilities) != len(ids) or any(
        not isinstance(p, (int, float)) or not math.isfinite(p) or not 0 <= p <= 1
        for p in probabilities
    ) or abs(sum(probabilities) - 1) > 1e-6:
        raise ValueError("Invalid SemIf probability distribution")
    if len(result["option_logits"]) != len(ids) or any(
        not math.isfinite(value) for value in result["option_logits"]
    ):
        raise ValueError("Invalid SemIf logits")
    return ids[max(range(len(ids)), key=lambda index: probabilities[index])]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=["smoke", "dev", "claims", "full", "dev-claims", "roadmap-holdout"], required=True)
    parser.add_argument("--inputs-dir", type=Path, default=ROOT / "frozen-inputs")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir()  # Create-only; no overwriting previous attempts.
    inputs = ["dev", "claims"] if args.suite == "dev-claims" else [args.suite]
    rows, hashes = [], {}
    for name in inputs:
        content = (args.inputs_dir / (name + ".jsonl")).read_bytes()
        hashes[name + ".jsonl"] = hashlib.sha256(content).hexdigest()
        rows.extend(json.loads(line) for line in content.splitlines() if line.strip())
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate planned ID")
    source = subprocess.check_output(["git", "-C", str(ROOT / "upstream"), "rev-parse", "HEAD"], text=True).strip()
    if source != SOURCE_REVISION:
        raise ValueError("SemIf source revision changed")
    sys.path.insert(0, str(ROOT / "upstream" / "src"))
    from semif_phase1.core import validate_row
    for row in rows:
        validate_row(row)
    metadata = {
        "candidate": "SemIf-Qwen3.5-4B-MLX-direct-source-precision",
        "sourceRevision": source, "model": MODEL, "modelRevision": REVISION,
        "suite": args.suite, "planned": [row["id"] for row in rows],
        "inputFiles": hashes, "maxTokens": 4096, "threshold": 0.85,
        "dependencies": {}, "setupSeconds": None, "warmupSeconds": None,
        "setupError": None, "fatalError": None,
        "note": "Raw uncalibrated probabilities; no labels loaded by inference process.",
    }
    started = time.perf_counter()
    attempted = 0
    errors = 0
    try:
        for package in ["semif-phase1", "mlx", "mlx-lm", "transformers", "torch", "huggingface-hub"]:
            metadata["dependencies"][package] = importlib.metadata.version(package)
        if metadata["dependencies"]["mlx"] != "0.32.2":
            raise ValueError("MLX does not match the official runtime pin")
        direct_url = json.loads(importlib.metadata.distribution("mlx-lm").read_text("direct_url.json") or "null")
        if not direct_url or direct_url.get("vcs_info", {}).get("commit_id") != "a63e24c389382619eb6d9af656e3b46024be217a":
            raise ValueError("MLX-LM does not match the official source pin")
        from semif_phase1.mlx_backend import load_model, score
        model, tokenizer, model_metadata = load_model(MODEL, REVISION)
        metadata["setupSeconds"] = time.perf_counter() - started
        metadata["modelMetadata"] = model_metadata
        # Owned upstream example: keep shader warmup separate from eval timings.
        warmup = json.loads((ROOT / "upstream" / "examples" / "decisions.jsonl").read_text().splitlines()[0])
        tick = time.perf_counter()
        warmup_result = score(model, tokenizer, warmup, model_metadata, 4096)
        check_result(warmup_result, warmup)
        metadata["warmupSeconds"] = time.perf_counter() - tick
        (args.output / "warmup.json").write_text(json.dumps(warmup_result, indent=2, allow_nan=False) + "\n")
        with (args.output / "rows.jsonl").open("x") as destination:
            for row in rows:
                tick = time.perf_counter()
                try:
                    native = score(model, tokenizer, row, model_metadata, 4096)
                    verdict = check_result(native, row)
                    result = {"id": row["id"], "verdict": verdict, "error": None, "fatal": False, "native": native}
                except ValueError as error:
                    # Context limits and response-validation errors are failed cases.
                    result = {"id": row["id"], "verdict": None, "error": str(error), "fatal": False, "native": None}
                    errors += 1
                except Exception as error:
                    result = {"id": row["id"], "verdict": None, "error": type(error).__name__ + ": " + str(error), "fatal": True, "native": None}
                    metadata["fatalError"] = result["error"]
                    errors += 1
                result["elapsedSeconds"] = time.perf_counter() - tick
                destination.write(json.dumps(result, allow_nan=False) + "\n")
                destination.flush()
                attempted += 1
                print(row["id"], result["verdict"] or result["error"], flush=True)
                if result["fatal"]:
                    break
    except Exception as error:
        metadata["setupError"] = type(error).__name__ + ": " + str(error)
        traceback.print_exc()
    finally:
        metadata.update(attempted=attempted, errors=errors, unattempted=len(rows) - attempted, elapsedSeconds=time.perf_counter() - started)
        (args.output / "run.json").write_text(json.dumps(metadata, indent=2, allow_nan=False) + "\n")
    print("Run:", args.output / "run.json", flush=True)
    return int(bool(metadata["setupError"] or metadata["fatalError"] or errors or attempted != len(rows)))


if __name__ == "__main__":
    raise SystemExit(main())
