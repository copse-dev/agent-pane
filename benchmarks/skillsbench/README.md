# SkillsBench Scaleway spike

This adapter runs Copse's headless agent loop inside the official SkillsBench v1.1 task and
verifier lifecycle. It pins SkillsBench tag `v1.1` at
`b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af` and BenchFlow `0.6.3`. The checked descriptor retains
all 87 active tasks and all 14 upstream exclusions.

The spike replaces only BenchFlow's agent/ACP composition plane. BenchFlow still builds the task
image, injects the official skill bundle for the two skill arms, executes the official verifier,
and writes its native result and trajectory artifacts. Copse runs on the worker host and forwards
`run_shell` and `read_skill` operations into the persistent task container.

Profiles are `skills-none`, `skills-product`, and `skills-explicit`. The first one-task run should
use `offer-letter-generator`; use all three profiles before drawing any conclusion. This branch is
an infrastructure spike, not a published benchmark result.

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
reward, release and task revisions, task digest, profile/content hash, full skill-bundle inventory
and digest, model, tokens, tool/skill-read counts, elapsed time, and Copse source commit.
