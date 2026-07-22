#!/usr/bin/env python3
"""Run a small pinned SkillsBench v1.1 study through BenchFlow 0.6.3."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from benchflow.rollout import Rollout, RolloutConfig

from copse_planes import CopseRolloutPlanes


PROFILES = ("skills-none", "skills-product", "skills-explicit")


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks-root", type=Path, default=Path("/opt/skillsbench/tasks"))
    parser.add_argument(
        "--descriptor",
        type=Path,
        default=Path("/opt/copse/benchmarks/skillsbench/dataset-v1.1.json"),
    )
    parser.add_argument("--bundle", type=Path, default=Path("/opt/copse/prebuilt/skillsbench-agent.cjs"))
    parser.add_argument(
        "--profile-script",
        type=Path,
        default=Path("/opt/copse/scripts/print-skillsbench-profile.mts"),
    )
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--task-names", default="offer-letter-generator")
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--jobs-dir", type=Path, default=Path("bench-results/skillsbench/jobs"))
    parser.add_argument(
        "--capsules-dir", type=Path, default=Path("bench-results/skillsbench-capsules")
    )
    values = parser.parse_args()
    if values.attempts < 1 or values.attempts > 5:
        parser.error("--attempts must be between 1 and 5")
    if values.shard_count < 1:
        parser.error("--shard-count must be positive")
    if values.shard_index < 0 or values.shard_index >= values.shard_count:
        parser.error("--shard-index must be within the shard count")
    return values


def _hash_tree(root: Path) -> tuple[str, list[dict[str, Any]]]:
    digest = hashlib.sha256()
    inventory: list[dict[str, Any]] = []
    if not root.is_dir():
        return f"sha256:{digest.hexdigest()}", inventory
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        data = path.read_bytes()
        file_hash = hashlib.sha256(data).hexdigest()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
        inventory.append(
            {"path": relative, "size": len(data), "digest": f"sha256:{file_hash}"}
        )
    return f"sha256:{digest.hexdigest()}", inventory


def _git_commit() -> str:
    configured = os.environ.get("GITHUB_SHA") or os.environ.get("COPSE_SOURCE_COMMIT")
    if configured:
        return configured
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _profile_metadata(script: Path, profile: str) -> dict[str, str]:
    result = subprocess.run(
        ["node", str(script), profile], capture_output=True, text=True, check=True
    )
    value = json.loads(result.stdout)
    if value.get("id") != f"{profile}@1" or not str(value.get("contentHash", "")).startswith(
        "sha256:"
    ):
        raise ValueError("profile metadata script returned invalid provenance")
    return value


def _result_mapping(result: Any) -> dict[str, Any]:
    fields = (
        "task_name",
        "rollout_name",
        "rewards",
        "agent",
        "agent_name",
        "model",
        "n_tool_calls",
        "n_skill_invocations",
        "n_prompts",
        "n_input_tokens",
        "n_output_tokens",
        "total_tokens",
        "usage_source",
        "error",
        "error_category",
        "verifier_error",
        "verifier_error_category",
        "partial_trajectory",
        "trajectory_source",
    )
    return {field: getattr(result, field, None) for field in fields}


def _reward(result: Any) -> float | None:
    rewards = getattr(result, "rewards", None)
    if not isinstance(rewards, dict):
        return None
    value = rewards.get("reward")
    if isinstance(value, (int, float)):
        return float(value)
    numeric = [float(item) for item in rewards.values() if isinstance(item, (int, float))]
    return sum(numeric) / len(numeric) if numeric else None


async def _run_trial(
    *,
    args: argparse.Namespace,
    descriptor: dict[str, Any],
    task: dict[str, Any],
    attempt: int,
    model: str,
    profile_metadata: dict[str, str],
) -> bool:
    task_name = task["name"]
    trial_id = f"{task_name}__{args.profile}__attempt-{attempt}"
    job_name = os.environ.get("COPSE_BENCH_RUN_ID", "skillsbench-spike")
    rollout_name = trial_id.replace("@", "-")
    planes = CopseRolloutPlanes(bundle=args.bundle.resolve(), profile=args.profile)
    agent_env = {
        "LM_STUDIO_URL": os.environ.get("LM_STUDIO_URL", "http://localhost:1234/v1"),
        "LM_STUDIO_MODEL": model,
        "LM_STUDIO_API_KEY": os.environ["LM_STUDIO_API_KEY"],
    }
    for name in (
        "COPSE_SKILLSBENCH_MAX_STEPS",
        "COPSE_SKILLSBENCH_MAX_LLM_CALLS",
        "COPSE_SKILLSBENCH_CONTEXT_TOKENS",
        "COPSE_SKILLSBENCH_MAX_STREAM_OUTPUT_TOKENS",
    ):
        if os.environ.get(name):
            agent_env[name] = os.environ[name]
    task_path = args.tasks_root / task_name
    skill_digest, skill_inventory = _hash_tree(task_path / "environment" / "skills")
    started = time.time()
    rollout = Rollout(
        RolloutConfig(
            task_path=task_path,
            environment="docker",
            sandbox_user=None,
            agent="copse-skillsbench",
            model=model,
            agent_env=agent_env,
            skill_mode="no-skill" if args.profile == "skills-none" else "with-skill",
            self_gen_no_internet=True,
            jobs_dir=args.jobs_dir,
            job_name=job_name,
            rollout_name=rollout_name,
            dataset={"name": "skillsbench", "version": descriptor["dataset"]["version"]},
            task_digest=task["digest"],
            source_provenance={
                "repository": task["git_url"],
                "revision": descriptor["dataset"]["revision"],
                "task_revision": task["git_commit_id"],
            },
            planes=planes,
        )
    )
    result = await rollout.run()
    elapsed = time.time() - started
    source_dir = args.jobs_dir / job_name / rollout_name
    capsule = args.capsules_dir / trial_id
    if capsule.exists():
        shutil.rmtree(capsule)
    if source_dir.is_dir():
        shutil.copytree(source_dir, capsule)
    else:
        capsule.mkdir(parents=True)
    bridge_result = getattr(planes, "last_result", None) or {}
    if bridge_result and bridge_result.get("profileHash") != profile_metadata["contentHash"]:
        raise RuntimeError("agent bridge profile hash disagrees with the preflight profile hash")
    manifest = {
        "schemaVersion": 1,
        "benchmark": {
            "id": "skillsbench",
            "version": descriptor["dataset"]["version"],
            "tag": descriptor["dataset"]["tag"],
            "revision": descriptor["dataset"]["revision"],
            "benchflow": descriptor["dataset"]["benchflow"],
        },
        "task": {
            "name": task_name,
            "revision": task["git_commit_id"],
            "digest": task["digest"],
        },
        "profile": {
            "id": profile_metadata["id"],
            "contentHash": profile_metadata["contentHash"],
        },
        "skillBundle": {
            "digest": skill_digest,
            "inventory": skill_inventory,
            "catalogued": args.profile != "skills-none",
            "injected": args.profile == "skills-explicit",
        },
        "sourceCommit": _git_commit(),
        "runnerImage": os.environ.get("COPSE_SKILLSBENCH_WORKER_IMAGE", "local"),
        "model": model,
        "networkPolicy": "no-network",
        "budgets": {
            "agentTimeoutSeconds": getattr(rollout, "_timeout", None),
            "defaultCommandTimeoutSeconds": 120,
            "maxCommandTimeoutSeconds": 600,
            "maxSteps": int(os.environ.get("COPSE_SKILLSBENCH_MAX_STEPS", "80")),
            "maxLlmCalls": int(os.environ.get("COPSE_SKILLSBENCH_MAX_LLM_CALLS", "83")),
            "contextTokens": int(
                os.environ.get("COPSE_SKILLSBENCH_CONTEXT_TOKENS", "32768")
            ),
            "streamOutputTokens": int(
                os.environ.get("COPSE_SKILLSBENCH_MAX_STREAM_OUTPUT_TOKENS", "4096")
            ),
        },
        "attempt": attempt,
        "elapsedSeconds": round(elapsed, 3),
        "officialReward": _reward(result),
        "result": _result_mapping(result),
    }
    (capsule / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str) + "\n")
    reward = manifest["officialReward"]
    print(
        f"skillsbench trial={trial_id} reward={reward} tools={result.n_tool_calls} "
        f"skill_reads={result.n_skill_invocations} elapsed={elapsed:.1f}s",
        flush=True,
    )
    return result.error is None and result.verifier_error is None


async def _main() -> int:
    args = _arguments()
    if not args.bundle.is_file():
        raise FileNotFoundError(f"Copse agent bundle is missing: {args.bundle}")
    if not args.profile_script.is_file():
        raise FileNotFoundError(f"profile metadata script is missing: {args.profile_script}")
    model = os.environ.get("LM_STUDIO_MODEL", "").strip()
    if not model or not os.environ.get("LM_STUDIO_API_KEY"):
        raise RuntimeError("LM_STUDIO_MODEL and LM_STUDIO_API_KEY are required")
    descriptor = json.loads(args.descriptor.read_text())
    profile_metadata = _profile_metadata(args.profile_script, args.profile)
    active = {task["name"]: task for task in descriptor["active"]}
    requested = [name.strip() for name in args.task_names.split(",") if name.strip()]
    unknown = [name for name in requested if name not in active]
    if unknown:
        raise ValueError(f"unknown SkillsBench v1.1 task(s): {', '.join(unknown)}")
    selected = [name for index, name in enumerate(requested) if index % args.shard_count == args.shard_index]
    if not selected:
        print("skillsbench shard has no selected tasks", flush=True)
        return 0
    args.jobs_dir.mkdir(parents=True, exist_ok=True)
    args.capsules_dir.mkdir(parents=True, exist_ok=True)
    successful = True
    for task_name in selected:
        for attempt in range(1, args.attempts + 1):
            successful = (
                await _run_trial(
                    args=args,
                    descriptor=descriptor,
                    task=active[task_name],
                    attempt=attempt,
                    model=model,
                    profile_metadata=profile_metadata,
                )
                and successful
            )
    return 0 if successful else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(_main()))
    except Exception as error:
        print(f"skillsbench spike: {error}", file=sys.stderr)
        raise
