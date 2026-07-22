# Terminal benchmark

This adapter runs the headless Copse agent loop against the official Terminal-Bench 2.0
task environments and verifiers. The model is accessed through an OpenAI-compatible endpoint;
shell commands are forwarded into the Docker task environment. Harbor records the verifier
outcome and Copse writes both a buffered raw trace and a normal thread transcript into each
trial's agent logs.

## Prerequisites

- Node.js from this repository's `.nvmrc`
- Docker running locally
- [`uv`](https://docs.astral.sh/uv/) with `uvx` available
- An OpenAI-compatible model endpoint and API key

Install this repository's dependencies once with `npm ci`, then export the endpoint settings:

```bash
export LM_STUDIO_URL='https://your-endpoint.example/v1'
export LM_STUDIO_MODEL='your-model-id'
export LM_STUDIO_API_KEY='your-api-key'
```

The `LM_STUDIO_*` names are retained for compatibility with the desktop provider, but the
benchmark does not require LM Studio. For a local run they can still point to LM Studio at
`http://localhost:1234/v1`.

## Run on a ten-instance Scaleway fleet

The manual `Terminal-Bench (Scaleway Fleet)` workflow uses GitHub only as the controller. It builds
one immutable worker image, pushes it to a private Scaleway Container Registry, launches ten
disposable x86 Scaleway Instances, and assigns each host one deterministic task shard. Each worker
container controls Terminal-Bench's sibling task containers through that host's Docker socket.
This is ten VMs, not ten containers sharing one fat VM.

Qwen inference stays on Scaleway's hosted Generative API. The worker Instances therefore do not
need GPUs and the image contains no model weights. The default `BASIC3-X4C-16G` hosts provide Docker
CPU, memory, and disk while API inference can proceed concurrently. All 89 pinned Terminal-Bench
task images are AMD64, so the fleet deliberately uses x86 Instances.

The controller terminates every VM in a `finally` path. Every host also receives a 420-minute
self-termination timer which deletes the server, root SBS volume, and flexible IP if GitHub loses
contact with it. Run evidence never becomes a GitHub artifact: each worker seals and uploads its
own capsules before it exits.

These VMs are never registered as GitHub self-hosted runners, so ordinary workflows cannot select
or reuse them through runner labels. Scaleway tags provide a second isolation boundary: benchmark
hosts use `copse-terminal-bench` / `copse-terminal-bench-fleet`, distinct from Copse's CI burst and
remote-e2e fleets. Status, cleanup, and TTL operations match both those tags and the run-specific
fleet name.

### One-time Scaleway and GitHub setup

Use a dedicated Scaleway Project so IAM scope, quotas, and spend remain isolated. Add a Project SSH
public key whose private half is stored in GitHub, create a private Container Registry namespace,
and create a private Object Storage bucket with SSE-ONE enabled. The controller must be able to
reach TCP/22 on each public VM; if you supply a custom security group, it and the optional custom
image must belong to the same zone configured by `SCW_TERMINAL_ZONE`.

Configure these GitHub Actions settings:

| Kind     | Name                               | Purpose                                                       |
| -------- | ---------------------------------- | ------------------------------------------------------------- |
| Secret   | `SCW_ACCESS_KEY`                   | Scaleway CLI access-key ID                                    |
| Secret   | `SCW_SECRET_KEY`                   | Instance lifecycle and private registry pull                  |
| Secret   | `SCW_DEFAULT_PROJECT_ID`           | Isolated benchmark Project                                    |
| Secret   | `SCW_DEFAULT_ORGANIZATION_ID`      | Parent Scaleway Organization                                  |
| Secret   | `SCW_SSH_PRIVATE_KEY`              | Matches the Project SSH public key                            |
| Secret   | `SCW_GENERATIVE_API_KEY`           | Hosted Qwen inference                                         |
| Secret   | `SCW_OBJECT_STORAGE_ACCESS_KEY_ID` | Capsule writer (`s3:PutObject`; ListBucket not required)      |
| Secret   | `SCW_OBJECT_STORAGE_SECRET_KEY`    | Capsule writer (`s3:PutObject`; ListBucket not required)      |
| Variable | `SCW_TERMINAL_REGISTRY`            | Registry namespace, for example `rg.fr-par.scw.cloud/example` |
| Variable | `SCW_OBJECT_STORAGE_BUCKET`        | Private capsule bucket                                        |
| Variable | `SCW_OBJECT_STORAGE_REGION`        | Bucket region; defaults to `fr-par`                           |

Optional variables are `SCW_GENERATIVE_API_URL`, `SCW_TERMINAL_ZONE`,
`SCW_TERMINAL_SECURITY_GROUP_ID`, and `SCW_TERMINAL_BASE_IMAGE`. The workflow tries multiple AZs
when `SCW_TERMINAL_ZONE` is unset because Instance quota is per AZ. It starts in Paris, skips
quota-exhausted or unsupported zones, then falls back through Amsterdam, Warsaw, and Milan until
the requested fleet is full. The registry and retained capsules remain in their configured region
(Paris by default), but transient worker disks and task execution reside in each worker's zone. Set
`SCW_TERMINAL_ZONE` when compute must remain in one AZ. A custom image UUID and a security group are
zone-specific, so either requires `SCW_TERMINAL_ZONE`.

Optionally add `BENCH_ANALYST_API_KEY` and `BENCH_ANALYST_API_URL` for a stronger OpenAI-compatible
analyst. When the analyst uses the same Scaleway endpoint, the workflow falls back to the
Generative API key and URL. Enter its model ID in the workflow's `analyst_model` input.

Preflight validates the Serverless model catalogue and writes a tiny AES-256 probe object under
`terminal-bench/_github_preflight/<run>/<attempt>/`. That matches worker capsule uploads
(`s3:PutObject`) and avoids `HeadBucket`, which Scaleway maps to `s3:ListBucket` and rejects for
PutObject-only keys.

Open **Actions → Terminal-Bench (Scaleway Fleet) → Run workflow**. The default launches ten hosts
and runs ten tasks, one on each host. Raise `max_tasks` to process more of the 89-task suite; with
ten hosts, each host then processes its deterministic shard sequentially. `instances` is capped at
20 and attempts at five. Hosted-model rate limits can still throttle the fleet even when Docker
capacity is available. Use the Serverless model ID from Scaleway's `/models` catalogue (for
example `qwen3.6-35b-a3b`), not an LM Studio or dedicated-deployment identifier.

### Pre-baked images and repeat-run speed

The workflow tags the worker image with the source commit and reuses it when it already exists.
Registry-backed BuildKit cache makes later source revisions cheaper to build. That image contains
Node, Python, `uv`, Harbor dependencies, the Copse adapter, Docker CLI plus CLI plugins (compose,
buildx), AWS CLI, `git`, and the exact source being evaluated.

Task images are intentionally separate: embedding all 89 would create an unwieldy worker image and
every host would pull it in full. For repeated runs over a stable shard set, create a zonal custom
Scaleway image from an x86 Ubuntu host whose `/var/lib/docker` already contains the relevant pinned
`alexgshaw/*:20251031` task images. Set its UUID in `SCW_TERMINAL_BASE_IMAGE` and pin the same zone in
`SCW_TERMINAL_ZONE`. The suite still verifies and records each resolved task image digest, and
prunes completed task images to keep the 100 GB root disk bounded. For a first run, leave the base
image as `ubuntu_noble` and let one-image-ahead prefetch overlap downloads with model work.

### Manual controller

The exact orchestration is also available without GitHub. Install and authenticate `scw`, export
the same model, registry, and Object Storage credentials, then run:

```bash
export LM_STUDIO_MODEL='qwen3.6-35b-a3b'
export SCW_GENERATIVE_API_KEY='...'
export SCW_SECRET_KEY='...'
export SCW_OBJECT_STORAGE_ACCESS_KEY_ID='...'
export SCW_OBJECT_STORAGE_SECRET_KEY='...'
export SCW_OBJECT_STORAGE_BUCKET='...'

npm run bench:terminal:fleet -- run \
  --instances 10 \
  --max-tasks 10 \
  --worker-image rg.fr-par.scw.cloud/example/terminal-bench-worker:COMMIT \
  --key-path /path/to/scaleway-ssh-key
```

Use `npm run bench:terminal:fleet -- status --name <fleet-name>` to inspect a detached or interrupted
fleet, and `npm run bench:terminal:fleet -- down --yes --name <fleet-name>` for explicit cleanup.
The manual command also terminates its hosts on completion or failure.

Every trial is sealed into its own gzip-compressed capsule and uploaded privately to
`s3://<bucket>/terminal-bench/<repository>/<workflow-run>/<attempt>/shard-<n>/` with AES-256 SSE-ONE
requested explicitly. Upload is attempted after benchmark failures too.

When `analyst_model` is set, the analyst inspects the latest failed attempt for each task and
writes the complete analyst input, raw response, diagnosis, metadata, and `steering.json` beneath
that parent trial. If `steered_rerun` is enabled, each analyzed task is run once more. The child
trial records the parent trial and intervention IDs and stores the exact injected steering. This
is post-run steering: the recorded `nudges` are retained for later live-steering work but are not
dynamically triggered during the child attempt.

GitHub only exposes a new `workflow_dispatch` workflow after the workflow file exists on the
default branch.

## Run locally

The default is deliberately small: one task, one attempt, one concurrent container.

```bash
npm run bench:terminal
```

Pass Harbor filters and execution options after `--`:

```bash
npm run bench:terminal -- --include-task-name 'task-name' -k 5
```

The official task timeout remains unchanged by default. For exploratory runs with a slow
local model, Harbor can grant the agent more wall-clock time explicitly:

```bash
npm run bench:terminal -- --agent-timeout-multiplier 2
```

Treat results produced with a timeout multiplier as a separate configuration when comparing
runs.

Use `--all` to remove the launcher's one-task cap. Five attempts per task produces the
attempt distribution used for full-suite comparisons:

```bash
npm run bench:terminal -- --all -k 5 -n 1
```

Use `--resume` with `--all` to exclude tasks that already have a valid local outcome.
Clean verifier outcomes and agent timeouts count as completed; Docker, adapter, and model-stream
exceptions are retried:

```bash
npm run bench:terminal -- --all --resume -n 1
```

For long local runs, the sequential suite driver is safer: it checks that each task wrote a new
valid result before advancing. `--resume` preserves valid prior outcomes, and `--prune-images`
removes only the completed task's pinned benchmark image after Harbor has stopped its container
and written the result. Shared Docker layers remain while another image references them.

```bash
npm run bench:terminal:suite -- --resume --prune-images --prefetch-images
```

`--prefetch-images` overlaps the next pinned image pull with the current agent run. It queues at
most one future image and only starts a pull with at least 30 GiB free. Override that threshold
with `COPSE_TERMINAL_PREFETCH_MIN_FREE_DISK_GIB`; pair prefetching with `--prune-images` to keep
Docker growth bounded.

Use `--max-tasks=N` for a bounded batch. The suite stops on a launcher failure or an
infrastructure-invalid result; rerunning the same resumable command starts at that task.

Inspect current coverage and lifecycle telemetry at any time without Docker:

```bash
npm run bench:terminal:report
```

Pass `-- --json` for machine-readable task and aggregate data.

Before Docker or the agent bundle starts, the launcher requires 15 GiB of host free space and
checks that the Docker daemon is healthy. Large benchmark images can expand to several gigabytes.
Set `COPSE_TERMINAL_MIN_FREE_DISK_GIB` to change the threshold (`0` disables it). During a run,
fatal Docker daemon and image-extraction failures terminate the Harbor process so later tasks are
left unattempted for the next resumable run instead of being silently skipped. `--dry-run` only
prints the command and does not build the bridge or require Docker.

Individual shell commands have a uniform 120-second bound and timeout results direct the agent
toward a bounded alternative. Override the bound with `COPSE_TERMINAL_COMMAND_TIMEOUT_SEC`. Timeout
counts are retained in result metadata and `bench:terminal:report`.

Results are written below `bench-results/terminal-bench/`. Keep concurrency at `1` unless
the local model server can reliably handle parallel requests. Use `--dry-run` to print the
pinned Harbor command without building the bridge, starting Docker, or downloading the dataset.

Each completed tool round checkpoints a transcript below the trial's `agent/thread/`
directory. It uses the same `meta.json`, `events.jsonl`, `messages/`, and `blobs/` layout as
the desktop thread store. `agent/thread/thread.jsonl` is the portable single-file export;
`agent/copse-trace.jsonl` retains the lower-level stream events. Reasoning-only cuts are also
written to `agent/stream-stats.jsonl` using the desktop stream-stat schema so they remain
directly analyzable even though cut reasoning never enters model history. Raw events cross
the host bridge in batches and are flushed at tool boundaries, avoiding a filesystem write
for every reasoning token. First-party lifecycle executions are recorded through the normal
hook-run sink in `agent/hook-runs.jsonl`, including the outcome of each pressure/runaway hook.
Because a host may apply a selected hook through a different mechanism or substitute recovery
text, `agent/applied-nudges.jsonl` separately records the exact message and mechanism the model
received.

`agent/provider-requests.jsonl` records the complete normalized message history and tool schema
presented to the OpenAI-compatible provider on every model call. Together with
`copse-trace.jsonl`, this preserves what entered and left the provider boundary after SDK
normalization; credentials and HTTP authorization headers are never recorded. Capsule sealing
also scans for the known model, analyst, and storage secret values and refuses the upload if one
appears in a retained file.

Each capsule contains a `run-manifest.json` with SHA-256 and size metadata for every original
trial file, source revision, non-secret execution limits, result summary, and lineage. A suite
`index.json` contains each compressed capsule's digest and size. The immutable task image and
source commit make the initial state reproducible; the suite records the resolved Docker image ID
and registry digest in `task-image.json` before optional pruning. Before Harbor destroys the task container, the
adapter retains `workspace-files.tsv` and downloads the complete gzip-compressed final working
directory as `workspace-final.tar.gz` when it fits under `COPSE_TERMINAL_WORKSPACE_CAP_MB` (500 MB
in the hosted workflow). Oversize and failed captures are recorded in result metadata without
replacing the benchmark outcome. Set the cap to `0` to disable the workspace archive.

Token, model-request, and tool-call totals are updated incrementally in Harbor's agent context,
so cancelled, timed-out, and model-stream-error trials retain the work observed before failure
instead of reporting zero usage.

The terminal host keeps the normal agent lifecycle and reasoning-runaway hook, but replaces
the desktop pressure policy that forces a tool-less chat answer after many tool rounds with one
tool-enabled instruction to stop broad inspection and implement a concrete draft. Terminal tasks
continue taking concrete actions until their configured step budget; desktop behavior is unchanged.
That late recovery requires the next command to make a best-effort edit before any more read-only
inspection, then runs the relevant verifier tests from `/tests` when they are available rather
than substituting an ad hoc smoke check.
A capped reasoning turn may contain up to 256 visible planning characters without
escaping the terminal recovery streak, and the configured stream cap still applies to
finalization turns. The initial terminal cap is 2k tokens; the one bounded retry after the
reasoning-runaway nudge gets a 4k cap so a complex local-model thought can reach a tool call
without restoring an unbounded stream. The terminal prompt also tells the agent to preserve damaged or stateful
inputs before programs that may checkpoint, recover, migrate, or rewrite them; this prevents an
inspection command from destroying the only copy of forensic task data. Iterative work also uses
copies instead of moving, deleting, or overwriting original task inputs before validation. Large task inputs should
stay in reusable files rather than being repeated in shell heredocs, and expensive searches should
start on a bounded subset before expanding. Recoverable command-timeout results reinforce that
guidance and tell the agent not to rerun an equivalent command unchanged. The prompt checks the
authoritative `/tests` directory before implementation, rather than allowing similarly named
workspace tests or ad hoc smoke checks to substitute for the verifier contract.
Large source, documentation, and log files are searched or read in bounded ranges instead of
being printed wholesale into every subsequent model request. Before installing dependencies, the
agent checks for lightweight tools already present and avoids large optional packages or model
weights unless the verifier requires them and there is no smaller route.

Optional tuning variables:

- `COPSE_TERMINAL_MAX_STEPS` (default `80`)
- `COPSE_TERMINAL_MAX_LLM_CALLS` (default: step limit plus `3` finalization calls)
- `COPSE_TERMINAL_CONTEXT_TOKENS` (default `32768`)
- `COPSE_TERMINAL_MAX_STREAM_OUTPUT_TOKENS` (default `2048`; terminal-only runaway guard)
- `COPSE_TERMINAL_REASONING_RECOVERY_MAX_STREAM_OUTPUT_TOKENS` (default `4096`; cap for the
  single nudged recovery stream)
- `COPSE_TERMINAL_COMMAND_TIMEOUT_SEC` (default `120`; a timeout is returned to the agent as
  exit code `124` so it can recover, including Harbor's wrapped Docker timeout)
- `COPSE_TERMINAL_WORKSPACE_CAP_MB` (default `500`; retain a complete compressed final workspace
  when it fits, while always attempting to retain the file manifest; `0` disables capture)
- `COPSE_BENCH_AGENT_VERSION` (label recorded in results; default `local`)

The launcher pins Harbor so the custom-agent API and result shape do not drift between
runs. Change that pin deliberately and revalidate the adapter before comparing results.
