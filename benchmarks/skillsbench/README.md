# SkillsBench Scaleway spike

This adapter runs Copse's headless agent loop inside the official SkillsBench v1.1 task and
verifier lifecycle. It pins SkillsBench tag `v1.1` at
`b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af` and BenchFlow `0.6.3`. The checked descriptor retains
all 87 active tasks and all 14 upstream exclusions.

Copse additionally predeclares study exclusions in the descriptor without rewriting the upstream
roster. The v1.1 study excludes `data-to-d3` because its reference `solve.sh` fetches d3 while both
agent trials and oracles run without network access. Requesting a study-excluded task fails before
either kind of trial launches; solution dependencies are not staged into the task image.

The spike replaces only BenchFlow's agent/ACP composition plane. BenchFlow still builds the task
image, injects the official skill bundle for the two skill arms, executes the official verifier,
and writes its native result and trajectory artifacts. Copse runs on the worker host and forwards
`run_shell` and `read_skill` operations into the persistent task container.

Profiles are `skills-none`, `skills-product`, and `skills-explicit`. The first one-task run should
use `offer-letter-generator`; use all three profiles before drawing any conclusion. This branch is
an infrastructure spike, not a published benchmark result.

## Reasoning arms

Each skill-delivery profile has two content-addressed versions that share a prompt and tool set and
differ only in how a reasoning-only stream is bounded:

- `@1` — the original single fixed per-stream output cap.
- `@2` — a checkpointed policy modelled on Terminal-Bench `product-aligned@3`, not a copy of it.
  A clean reasoning-only stream is reassessed once per stream cap and may continue up to the
  product's 32k per-stream ceiling; a high-confidence circle signal cuts it into a recovery stream
  capped at twice the stream cap. It sets no trailing-reasoning budget.

`@2`'s hash has the same weakness that retired Terminal-Bench `product-aligned@3`: it names the
reasoning implementation with a description. The checkpoint interval follows
`COPSE_SKILLSBENCH_MAX_STREAM_OUTPUT_TOKENS`, and the circle detector is the product's live one,
which gained `repeated_sentence`/`repeated_tail` signals in #1242 and visible-text and cross-turn
checks in #1413. `@2` runs from before and after those changes, or with different stream caps,
share one hash. Compare `@2` runs only within a single source commit and stream-cap setting until
SkillsBench profiles adopt the effective-value hashing Terminal-Bench uses from `product-aligned@5`
(see [`benchmarks/terminal_bench/README.md`](../terminal_bench/README.md)).

A bare id such as `skills-product` stays pinned to `@1`, so existing dispatches and their content
hashes keep their exact meaning and the checkpointed arm is always requested explicitly.

Run a paired arm study on one fleet with `--profiles` (the workflow's `profiles` input), for
example `skills-product@1,skills-product@2`. Trials are task-major, so both arms see the same task
back to back on the same worker. Every checkpoint decision and circle signal is retained in the
capsule as `reasoning-checkpoints.jsonl` and summarised under `manifest.json` → `reasoning`.

## Local container smoke

Build the same amd64 worker used by the workflow:

```sh
docker build --platform linux/amd64 -f benchmarks/skillsbench/Dockerfile.worker -t copse-skillsbench-spike .
```

Run it with the Docker socket, model credentials, and S3-compatible capsule destination supplied
as environment variables. The worker requires an explicit profile and task list; there is no
implicit benchmark default during the spike.

## Scaleway

Dispatch `.github/workflows/skillsbench-scaleway-spike.yml`. It builds one immutable worker image,
launches disposable x86 Scaleway instances, streams each worker, uploads capsules to Object
Storage, and terminates the fleet in an `always()` cleanup step. The workflow reuses the existing
`SCW_TERMINAL_REGISTRY`, Scaleway Instance, Generative API, SSH, and Object Storage configuration
used by Terminal-Bench.

Each capsule contains the complete BenchFlow rollout plus `manifest.json`, including the official
reward, release and task revisions, task digest, profile/content hash, reasoning policy and
checkpoint summary, full skill-bundle inventory and digest, model, tokens, tool/skill-read counts,
elapsed time, and Copse source commit.

## Minimum-work policy

Before aggregation, `minimum-work-v1` voids a trial with fewer than 1,000 input tokens or no tool
calls. The capsule retains the verifier's raw reward as `verifierReward`, but exposes a null
`officialReward` for a void trial so it cannot silently count as a scored failure. Its `status`,
`voidReason`, and complete `trialPolicy` travel with the capsule, and the fetch workflow reports the
void count in both `trial-summary.jsonl` and the Actions summary.

The 1,000-token boundary was declared in response to the 982-input-token `dialogue-parser` trial
from run 30225392613: it made two calls, ended without a runner or verifier error, and remains
unexplained. This policy distinguishes that missing trial from a genuine zero reward without
retroactively changing the threshold after viewing a new cohort.
