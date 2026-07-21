# Local terminal benchmark

This adapter runs the headless Copse agent loop against the official Terminal-Bench 2.0
task environments and verifiers. The model stays on the host in LM Studio; shell commands
are forwarded into the Docker task environment. Harbor records the verifier outcome and
Copse writes both a buffered raw trace and a normal thread transcript into each trial's
agent logs.

## Prerequisites

- Node.js from this repository's `.nvmrc`
- Docker running locally
- [`uv`](https://docs.astral.sh/uv/) with `uvx` available
- LM Studio's local server running with a model loaded and an API key configured

Install this repository's dependencies once with `npm ci`, then export the local model
settings:

```bash
export LM_STUDIO_URL=http://localhost:1234/v1
export LM_STUDIO_MODEL='your-loaded-model-id'
export LM_STUDIO_API_KEY='your-lm-studio-api-key'
```

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
- `COPSE_BENCH_AGENT_VERSION` (label recorded in results; default `local`)

The launcher pins Harbor so the custom-agent API and result shape do not drift between
runs. Change that pin deliberately and revalidate the adapter before comparing results.
