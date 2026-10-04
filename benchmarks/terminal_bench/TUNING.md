# Tuning Copse's defaults against Terminal-Bench

This is the workflow for hill-climbing on parameters that could become Copse's product defaults,
using the Harbor container agent (`copse_container_agent.py`, decision A20 in
`docs/plans/thread-in-container.md`) as the measurement. It is a measuring tool. It never changes a
product default; a winning value becomes a product change by the separate PR described at the end.

## What is tunable

A tuning is a small JSON object with a strict schema
(`src/main/services/container-runtime/harbor-tuning.mts`): unknown keys and bad values are rejected,
and only keys with a real seam behind them exist.

| key                                                                                       | read by | effect                                                                           |
| ----------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `loopLimits.maxSteps / maxLlmCalls / adaptiveExtensions`                                  | worker  | the loop's call budget (omit for the product's own limit plus extensions)        |
| `reasoningRecoveryMaxTokens`                                                              | worker  | cap on the one recovery stream after a reasoning circle is cut                   |
| `modelParametersMode`                                                                     | host    | `server` sends no sampling (LM Studio defaults), `client` sends the model recipe |
| `sampling.{temperature,topP,topK,minP,presencePenalty,repetitionPenalty,maxOutputTokens}` | host    | sampling sent with every request, over the mode's base                           |
| `contextWindow`                                                                           | host    | the window the loop is told the model has (drives compaction)                    |

Not tunable yet, because no seam exists: the reasoning checkpoint interval and the initial/trailing
reasoning caps (the product policy is a constant; only the recovery cap is plumbed).

The path of a tuning, and why the product worker cannot reach it:

```
COPSE_HARBOR_TUNING (JSON, or @path)   Python agent, copse_container_agent.py
  -> --tuning-file                      host driver, harbor-container-driver.mts (validates, strict)
  -> tuning.json in the container run dir   written by the driver, worker keys only
  -> worker-entry-harbor.ts             the only reader in the container
  -> tuning.applied.json                the entry records what it applied; the driver merges the
                                        host's resolved sampling/context window and writes
                                        <trial>/agent/out/tuning.applied.json next to result.json
```

`worker-main.ts` (shared with the product) only gained a neutral, code-supplied `loopLimits` profile
field, like the existing `reasoningRecoveryMaxTokens`. `worker-entry-gating.test.ts` fails if the
product entry, its import graph or its bundle bytes mention `harbor-tuning`, `tuning.json`,
`tuning.applied.json` or `COPSE_HARBOR_TUNING`.

Without a tuning the Harbor entry behaves as before (including its 12,288 recovery cap). The seeded
space below sets 4,096 (the product default) explicitly for its incumbent, so its `default` config is
not the same as a pre-tuning Harbor run.

## The moving parts

All under `scripts/tuning/`, Node `.mts`:

- `space.json`: parameters, defaults, ordered candidate values, the fixed `base` tuning, and three
  disjoint task sets (screen, confirm, canary). The first value of each list is the default.
- `run-trials.mts`: run (config, task, rep) trials, interleaved by rep, and append one line per
  trial to `bench-results/tuning/ledger.jsonl`. Resumable. `--dry-run` prints the exact commands.
- `analyze.mts`: the statistics below, from the ledger.
- `hillclimb.mts`: coordinate ascent with successive halving. `--plan` prints the schedule and the
  cost without launching anything.

```bash
# What would a trial cost, exactly?
node scripts/tuning/run-trials.mts --config default --tasks regex-log,largest-eigenval --reps 3 \
  --interleave '{"reasoningRecoveryMaxTokens":8192}' --dry-run

# Measure two configs on a task list, 3 reps each, interleaved
node scripts/tuning/run-trials.mts --config default --tasks regex-log,largest-eigenval --reps 3 \
  --interleave '{"reasoningRecoveryMaxTokens":8192}'

# Analyze whatever is in the ledger
node scripts/tuning/analyze.mts [--baseline default] [--min-effect 0.1]

# Plan, then climb within a budget; re-running resumes
node scripts/tuning/hillclimb.mts --plan
node scripts/tuning/hillclimb.mts --max-hours 12
```

A config is a tuning plus an id. Its identity is the sha256 of the canonical tuning, so a ledger line
always says exactly what was measured (`config.hash`, and the resolved `tuning`). `--config` takes
`default`, an inline JSON tuning, or the id of a config an earlier run registered under
`bench-results/tuning/configs/`.

## The ledger and invalid trials

Each line has: config id and hash, the resolved tuning, task, rep, reward, agent seconds, model
calls, tokens, stop reason, exception type and message, denials, deferrals, prompts attempted, the
LM Studio models loaded when the job started (when obtainable), the code revision the payload was
built from, timestamps and the job directory.

A trial is **invalid** (kept in the ledger, excluded from every statistic) when:

- it ended in any exception other than `AgentTimeoutError` (a timeout is a legitimate failed attempt);
- the driver's logs or a stream-cut reason show a model unload, a model crash or a connection error
  (the agent's transcript is never scanned: a task about a crash must not invalidate itself);
- it left no `result.json`, no reward (without a timeout), or did not record applying exactly the
  requested tuning.

`--retry-invalid` (or `--max-attempts 2`) lets the runner try an invalid cell once more.

## Metric choices, and why paired, task-level statistics

The metric is **pass rate**: the share of trials whose verifier reward is exactly 1. Agent seconds,
model calls and tokens are reported beside it as cost, never traded against it inside a verdict.

The same code flips pass/fail on tasks such as `git-multibranch`, `largest-eigenval`,
`configure-git-webserver` and `multi-source-data-merger`. So:

- **The unit is the task, not the trial.** Reps within a task are averaged first. Pooling trials would
  let a task that happened to be run more often count for more, and would treat reps of one task as
  independent evidence about the whole suite.
- **Comparisons are paired.** Both configs run the same tasks, so task difficulty cancels; what is
  left is the difference, task by task. Candidate and incumbent trials are interleaved by rep so slow
  drift (thermal state, server load, a model reload) is spread over both.
- **The interval is a seeded two-level bootstrap**: tasks are resampled, then each config's reps
  within a drawn task, so the interval carries both task-to-task spread and run-to-run flipping. The
  seed makes an analysis reproducible.
- **A noise floor is measured from the data.** For each task with at least two reps of the same
  config, the pass-rate variance across reps, the share of tasks that flip, and from them the
  standard deviation of the difference two independent runs of identical code would show. Two
  identical configs differ by more than 1.96 of those about 5% of the time.
- Pooled and per-task pass rates carry Wilson 95% intervals (they behave at 0% and 100%).

## Reading a verdict

Each comparison of a candidate to the baseline ends in exactly one of:

- **better beyond noise** / **worse beyond noise**: the bootstrap interval for the difference excludes
  zero, the observed difference exceeds the replicate noise floor, and at least `--min-tasks` (8)
  tasks have at least `--min-reps` (2) valid reps in both configs.
- **no detectable difference**: the interval is narrow enough to rule out a difference of
  `--min-effect` (0.1) in either direction. This is a statement about the data, not proof of equality.
- **underpowered**: anything else. The output says why (too few tasks, a task with one rep, an interval
  too wide, an interval that excludes zero but is inside the noise floor) and how much more would
  settle it for the effect of interest at 80% power: roughly N more tasks at the current reps, or R
  reps per task on the current tasks (or that reps alone cannot do it, because the task-to-task spread
  dominates).

It never calls a win from one rep per task: a task with fewer than two valid reps in either config is
excluded and listed. Simulated climbs against a fake evaluator (the seeded 4/10/4 task split, 3 reps, 100 seeds each)
never accepted a null effect (0 of 100); accepted a +0.2 pass-rate improvement on the hard tasks about
1 time in 4, a +0.3 one about 3 in 4, and a +0.5 one about always. Small improvements need many more
tasks than the seeded sets hold, which is the honest answer: the climb will report them as underpowered.

## The hill climber

Coordinate ascent with successive halving, from the all-defaults incumbent:

1. Propose one-parameter neighbours (`--neighbours adjacent`, one step along each value list, or
   `all`).
2. **Screen** each on the small discriminating task set (tasks whose outcome varies), `k` reps,
   interleaved with the incumbent. A point estimate, used only to choose.
3. **Promote** the best half (at least one, only those that beat the incumbent on the screen).
4. **Confirm** on a wider set disjoint from the screen, plus a **canary** set of easy tasks. The
   verdict is decided on the confirm set only, so choosing winners from the screen cannot inflate it.
   An underpowered but positive candidate is re-run once with double the reps.
5. **Accept** only on `better beyond noise` with no canary regressing (a canary task losing half its
   pass rate, or missing data, rejects). The accepted candidate becomes the incumbent and the next
   round starts.

It stops at the first round with no acceptance, at `--max-rounds`, or at `--max-trials` /
`--max-hours` (checked before each job). Every measurement is in the ledger, so a re-run replays the
same decisions for free and continues; `--plan` is resume-aware. `bench-results/tuning/report.md`
lists each accepted change with its evidence table and a ready-to-use PR checklist, and
`climb-journal.json` has every decision including rejected ones.

The canary and confirm sets in `space.json` are a provisional choice: replace them with tasks the
incumbent is measured to solve reliably (canary) and tasks that are neither always solved nor never
solved (confirm) as the ledger fills.

## From a winning parameter to a product default

1. Take the accepted change from `report.md`. Do not edit product defaults from this tool.
2. Re-run the final config against the starting config on a task set the climb never used, and
   confirm the verdict holds.
3. Open a **separate PR** that changes the product constant named in the checklist (for example
   `PRODUCT_REASONING_RECOVERY_MAX_TOKENS` in `packages/agent/src/reasoning-checkpoint-policy.ts`), with
   the evidence tables, the config hashes and the ledger lines in the description, and updates any test
   or doc that pins the old value. A parameter with no product seam (`productSeam: null` in the space)
   needs the seam added first.
4. Remember the benchmark measures one model on one benchmark. Say so in the PR, and check that the
   change is not model-specific before it becomes a default for every model.
