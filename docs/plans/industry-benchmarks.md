# Industry benchmarks as plumbing evals

Tracking: [#752](https://github.com/copse-dev/agent-pane/issues/752)

Status: **Phase 1 landed, Phase 2 scaffolded, terminal lane started.** Phase 1's deterministic
replay corpora are in the per-PR unit tier
(`tests/fixtures/tool-call-dialect-corpus.json` +
`parse-text-tool-calls.corpus.test.ts`,
`tests/fixtures/tool-args-json-corpus.json` +
`parse-tool-args.corpus.test.ts`, and
`packages/agent/src/trim-history.needle.test.ts`). Phase 2's headless
harness is `npm run bench:agent` (`scripts/bench-agent-lib.mts`) over
`benchmarks/tasks/*.json`, with a deterministic `--mock` self-test, an LM
Studio path, git-checkout workspaces, and a `--gate` /
`--update-baseline` trend ratchet against `benchmarks/bench-baseline.json`
(the coverage-baseline pattern). CI runs the mock self-test + gate per PR
inside the `bench` job; the `bench-agent-model` job runs the SWE-bench
Verified pinned subset (`benchmarks/swe-bench/verified-subset.ids.json`
resolved by `npm run bench:swe-tasks`, graded by applying each instance's
held-back test patch and running its `FAIL_TO_PASS` pytest ids) nightly or
via the `bench-agent` label on a runner named by the `LM_EVAL_RUNNER`
variable. Grading fidelity caveat: the runner's Python env, not the
official per-instance Docker images — trend data, not leaderboard claims.
Phases 2b–4 remain. This doc maps where public agent benchmarks
(SWE-bench, Terminal-Bench, BFCL, TAU-bench, RULER-style long-context
suites, MCP conformance suites) plug into the harness we already have,
and what each one buys the _plumbing_ specifically.

The first local Terminal-Bench adapter is `npm run bench:terminal`. It runs the
existing headless agent loop on the host, forwards shell calls into Harbor's official
Docker task environments, keeps the official verifier as the outcome authority, and
writes a buffered raw trace plus a thread-store-compatible transcript beside each trial.
The transcript is checkpointed after tool rounds, uses the normal spine/OKF serializers,
and includes the portable thread JSONL consumed by the existing analyzer. It also records
the existing function-hook run stream beside the transcript so pressure and runaway nudge
selection remains attributable during benchmark analysis. A separate applied-nudge stream
records the exact host-substituted text and whether it was tool-enabled or text-only. The benchmark
also lowers the per-stream reasoning-runaway guard to 2k output tokens without changing
the desktop default. The one bounded stream after that recovery nudge may use a 4k cap, giving
a complex local-model thought one chance to reach a tool call without returning to an unbounded
runaway. Its host-specific recovery nudge directs a stalled terminal agent to
create the best current deliverable candidate instead of continuing analysis with the requested
path absent. It also replaces
the pressure-triggered tool-less answer turn for this host with one tool-enabled recovery
instruction, because terminal success is durable environment state rather than prose; the
configured output cap still bounds finalization. The recovery probes `/tests` once, treats it as
the verifier authority when available, and avoids repeatedly searching for hidden verifier files
when the harness has not mounted them during the agent phase. Task-local checks must be invoked
with their real runner—a silent script that merely defines tests is not accepted as verification.
The recovery also requires a best-effort edit before any further read-only inspection. The
terminal host also treats a short visible planning preamble on an otherwise reasoning-dominated
cut as part of the same bounded runaway streak. The launcher defaults to one task and one attempt
for local smoke testing. Its prompt also preserves forensic/stateful inputs before potentially
mutating inspection tools, avoiding accidental evidence loss, and keeps original task inputs
unchanged while iterative work runs on copies. `--all -k 5` expands it to the
repeated-attempt lane. The terminal prompt also keeps large inputs in reusable files, bounds
large file reads and expensive searches before expansion, avoids large optional dependency/model
downloads when existing lightweight tools can solve the task, and checks the authoritative `/tests` directory before
implementation rather than accepting similarly named workspace tests. Agent-context usage counters update from each streamed event,
so infrastructure-invalid and timed-out trials retain partial token/tool/request telemetry for
postmortem analysis. Full local runs can use `--all --resume`: clean outcomes and agent timeouts
are excluded, while infrastructure-invalid trials remain eligible. The launcher checks host disk
space and Docker health before starting, and terminates a suite on fatal daemon/image-extraction
output so an infrastructure outage cannot silently consume the remainder of the task queue. The
sequential suite driver additionally verifies that each task wrote a valid new result before
advancing and can remove that completed task's pinned image to bound local Docker growth. Its
optional one-image-ahead prefetch overlaps the next pull with inference, guarded by a separate
30 GiB free-space floor so provisioning latency can be hidden without recreating unbounded disk
pressure.

The adapter now targets Terminal-Bench 2.1 and exposes four versioned experiment profiles:
`main-legacy@1` (the unchanged original adapter), `pr-1149@1` (the exact constrained-write and
validation-warning experiment), and `product-aligned@2` (workspace-aware regular shell/write
semantics without task-specific recovery). `product-aligned@3` preserves v2's prompt/tools and
reassesses a reasoning-dominated stream every 2k tokens: clean streams may expand to the product's
32k hard cap, while high-confidence self-reported or structural circles enter the existing bounded
recovery. Historical `product-aligned@1` and v2 capsules remain readable.
`main-legacy` remains the default. Dataset revision, task configuration
checksum, resolved image digest, profile ID, and profile content hash are retained with every
trial. The complete negative and protocol-progress evidence behind `pr-1149@1` is preserved in
[`docs/spikes/terminal-bench-pr-1149.md`](../spikes/terminal-bench-pr-1149.md).
The two-attempt 2.1 result, adapter defects, corrected v2 targeted follow-up, and compact evidence
retention policy are recorded in the canonical findings note
[`docs/spikes/terminal-bench-2.1-profile-ablation.md`](../spikes/terminal-bench-2.1-profile-ablation.md).

The ablation is precommitted in code: the four #1149 tasks form a one-attempt diagnostic cohort,
while the held-out cohort excludes them and selects 12 tasks by sorting
`SHA256("copse-tbench-2.1-ablation-v1:" + taskName)`. Each held-out profile gets five attempts with
the same `qwen3.6-35b-a3b` configuration. The comparison reports macro-average official reward,
paired per-task differences with a task bootstrap 95% interval, solves, tokens, tool calls, elapsed
time, and failure categories. A non-default profile is eligible only when the held-out interval
excludes zero, all expected attempts are present, and median tokens and elapsed time stay within
25% of the baseline unless it adds solved tasks. Otherwise `main-legacy@1` remains the benchmark
default. The #1149 forced-write and task-specific warning mechanisms remain benchmark-only. After
two paired targeted runs favored v3, the generic reasoning checkpoint policy is also used by the
built-in Copse agent: 2K reasoning checkpoints inside the existing 32K product ceiling, with a 4K
recovery ceiling. ACP and other externally hosted agents are unchanged.

## The framing: benchmarks as harness evals, not model evals

Leaderboards use benchmarks to rank models. That is not the opportunity here —
Copse doesn't train models. The opportunity is the inverse experiment: **hold
the model constant and vary the plumbing.** Copse owns an unusually deep stack
of harness machinery whose value is currently asserted, not measured:

- loop guards, duplicate-explore detection, finalize nudges, todo gating
  (`agent-loop-guards`, `agent-loop-escalation`)
- in-loop compaction and context accounting (`trim-history`,
  `context-breakdown`, `working-brief`)
- thread-native task-state surfacing (working brief, todos, OKF thread history,
  tool-result evidence) versus pull-only durable memory
- tool-call recovery for sloppy dialects (`parse-text-tool-calls`,
  `parse-tool-args`, provider stop-reason normalization)
- search routing, read-file paging, subagent orchestration
- experimental routing scaffolds: model classifier (#557), advisor strategy
  (#566)

Every one of these is a testable hypothesis of the form "this feature makes an
agent solve more tasks / burn fewer tokens." Industry benchmarks are exactly
the task pools that let us test those hypotheses with external validity,
instead of hand-written scenarios only. The existing scenario analyzer
(`analyze-thread-jsonl.mts` with `maxExplore` / `maxInputTokens` / tool
expectations) already scores runs this way — benchmarks give it scale and
tasks we didn't author ourselves.

## What each benchmark family buys us

| Benchmark family                           | Plumbing it exercises                                             | How it runs                             |
| ------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------- |
| **BFCL / recorded tool-call corpora**      | `parse-tool-args`, `parse-text-tool-calls`, stop-reason machinery | deterministic replay, per-PR `npm test` |
| **RULER / needle-in-haystack style**       | `trim-history`, `working-brief`, context accounting               | synthetic threads, mostly deterministic |
| **SWE-bench (Verified subset)**            | whole loop: guards, budgets, search routing, subagents            | nightly, self-hosted + real model       |
| **Terminal-Bench**                         | autonomous shell-loop and host-adapter semantics                  | nightly, self-hosted                    |
| **SkillsBench**                            | skill discovery, progressive disclosure, instruction lift         | paired nightly / label-gated            |
| **TAU-bench style multi-turn tool tasks**  | multi-turn tool reliability, ask-user flow                        | nightly / label-gated                   |
| **MCP conformance suites (MCPBench-like)** | MCP host: server lifecycle, approval, tool namespacing            | mostly deterministic, per-PR viable     |

Two structural benefits fall out regardless of scores:

1. **A headless benchmark adapter is the first true external consumer of
   `@copse/agent`.** Both package READMEs say the remaining step is lifting
   them into standalone repos. A bench harness that drives `run-agent-loop`
   through `agent-host` with _no Electron and no `src/main` imports_ proves the
   boundary continuously — any accidental host coupling breaks the bench build
   before it breaks the extraction. This is the same role `validate:local-agent`
   plays today, but against real tasks with checkable outcomes instead of "does
   the model finish with text."
2. **Benchmark harnesses standardize an interchange shape** (task in,
   prediction/patch out, trace alongside). Adopting it gives us a stable
   headless entry point that other harnesses can drive — which also dovetails
   with the ACP work: an agent that can be driven over ACP is an agent a
   third-party benchmark runner can drive without bespoke glue.

## Phased plan

### Phase 1 — deterministic replay corpora (cheap, per-PR)

No model at test time; pure fixtures. Fits tier 1 of
[`docs/testing-strategy.md`](../testing-strategy.md).

- **Tool-call parsing conformance.** Build a fixture corpus of provider stream
  transcripts — BFCL-style cases plus redacted captures of real provider
  quirks (the MiniMax bare-`<invoke>` dialect just handled in #724 is exactly
  the kind of case that should live in a corpus, not just a regression test).
  Replay through the provider adapters and `parse-text-tool-calls`; assert the
  recovered calls. Every new dialect bug becomes a corpus entry.
- **Context-compaction needle tests.** Generate long synthetic threads with
  planted facts and open todos; run `trim-history` / `working-brief`
  compaction; assert the plants survive and budgets are respected. This is a
  RULER-shaped eval of _our compaction_, not of the model.

### Phase 2 — headless SWE-bench-subset harness (nightly)

- A `scripts/bench-agent.mts` (or `packages/bench-harness`) that adapts a
  pinned SWE-bench Verified subset (10–30 instances, fixed) to
  `run-agent-loop` via `agent-host`: clone the instance repo into a temp
  workspace, register the real file/search/shell tools, run the loop headless,
  emit the patch plus the same thread JSONL that `analyze:thread` already
  scores, then apply the benchmark's own test-based grading.
- Runs where the local-model eval already lives: nightly / label-gated on the
  self-hosted fleet with LM Studio, or a cheap cloud model — explicitly **out
  of the per-PR path**, per the testing strategy's CI-cost rule.
- Track two numbers per run, as trend baselines in the repo (the
  `coverage-baseline.json` pattern): **solve rate** and **tokens per solved
  task**. The second is the plumbing-efficiency metric — compaction, dedupe
  guards, and search routing exist to move it.

### Phase 2b — terminal-task and small-model stress lane

- Add a Terminal-Bench-compatible adapter through the same headless host. Keep the
  task checkout, command transcript, final workspace diff, verifier result, model id,
  runtime flags, and stop reason together as one replayable run artifact.
- Make a local/smaller-model lane first-class. Plumbing differences are easiest to see
  where context pressure, malformed tool calls, repeated exploration, command failure,
  and premature completion are common; a frontier-only lane can hide those effects.
- Run every task multiple times with a fixed model/configuration and report the per-task
  distribution, not just a single aggregate. Distinguish stable wins (`N/N`), unstable
  tasks, coverage (`>=1/N`), and the zero-pass frontier (`0/N`) so iteration can target
  failure classes instead of score-chasing.
- Treat self-run results as lower-bound trend evidence until the exact environment and
  verifier are reproducible outside the originating runner. Raw traces and grading
  artifacts are required for any published comparison.

### Phase 3 — plumbing A/B mode

The payoff phase. Add a flag matrix to the Phase 2 harness so one invocation
runs the same model over the same task subset with a plumbing feature toggled:
trim-history on/off, todo gating on/off, duplicate-explore guard on/off,
working-brief on/off. Extend the matrix with candidate features before committing
them to the core loop:

- compact thread-derived task state on/off;
- thread-history search/state tools on/off;
- generic durable memory tools on/off for short tasks, to test whether they add value
  beyond the thread rather than assuming they do;
- completion evidence gates on/off (material diff, validation artifact, or an explicit
  blocked/unverified outcome);
- targeted validation and bounded repair on/off.

Report the delta in solve rate and tokens-per-solve. A feature that only improves prompt
appearance or produces more activity has not paid for itself.

- Non-determinism is handled statistically, not wished away: fixed subsets,
  N repeats per arm, report ranges; treat results as trends, never PR gates.
- This converts "we believe the finalize nudge helps" into a measured claim,
  and — just as valuable — licenses _deleting_ guards that measure as neutral.
  The loop machinery only stays honest if features must pay rent.

### Measurement contract

Each arm records enough structured telemetry to explain a score change:

- outcome: verifier pass, material diff, validation evidence, and terminal stop reason;
- efficiency: input/output tokens, model requests, tool calls, wall time, and commands;
- loop quality: duplicate tool calls, repeated failed commands, file reopens, recovery
  nudges, compactions, and context pressure at stop;
- task-state use: projected-state injections, task-history searches, task annotations,
  and durable-memory reads/writes;
- reproducibility: task revision, verifier revision, model identifier, sampling settings,
  runtime feature flags, attempt number, patch, and full thread artifact.

Aggregate solve rate stays the headline trend, but per-task attempt histograms and failure
taxonomy drive the next engineering iteration. Compare one runtime variable at a time where
possible; bundled "new runtime" versus "old runtime" runs cannot attribute the improvement.

### Phase 4 — feed routing scaffolds with benchmark ground truth

The model classifier (#557) maps tasks to `fast` / `balanced` / `frontier`
tiers on keyword heuristics, and the advisor strategy (#566) pairs a big
advisor with a small executor — both currently without ground truth. A
benchmark matrix (models × task categories from Phases 2–3) is that ground
truth:

- derive the classifier's tier→model table from measured solve rates and cost
  per category, instead of a hand-picked Anthropic-only mapping;
- validate advisor/executor pairings by running the same subset with and
  without the advisor and measuring the lift;
- optionally let `sync:models` carry published benchmark scores as
  model-catalog metadata so the picker/classifier can surface "why this
  model."

## Cautions

- **Contamination and overfitting.** Public benchmark tasks are in every
  frontier model's orbit. That poisons _model_ ranking claims but matters much
  less for A/B-ing plumbing with the model held constant — the deltas are
  still informative. Don't tune loop heuristics against the same fixed subset
  forever; rotate subsets occasionally.
- **Cost discipline.** Everything model-driven stays nightly/label-gated on
  self-hosted runners, mirroring the existing local-model eval posture. The
  per-PR tier only gets Phase 1's deterministic replays.
- **No score-chasing.** The deliverable is regression trend lines and feature
  deltas for the harness, not a leaderboard entry. If a published number ever
  becomes interesting for the site, it's a by-product, not the goal.

## Relationship to existing pieces

- `docs/plans/skillsbench.md` (planned, not yet written) defines the paired SkillsBench v1.1 study. It keeps
  skill content value, autonomous discovery, and explicit `/skill` injection as separate arms so a
  selection failure cannot be mistaken for a useless skill.
- The product-host runtime contract remains tracked by
  [#1079](https://github.com/copse-dev/agent-pane/issues/1079), building on the headless-harness
  direction in [#752](https://github.com/copse-dev/agent-pane/issues/752). This Terminal-Bench slice
  changes only the adapter and evidence trail; BFCL expansion, MCP-Universe, and τ³-bench-style
  integrations remain later consumers of the same profile and manifest machinery.
- `wdio.eval.conf.ts` / `agent-run-eval` stay the UI-in-the-loop harness for
  behavioral issues; the bench harness is headless and outcome-graded.
- `validate:local-agent` becomes the smoke test for the Phase 2 harness's
  loop-hosting seam (same headless setup, trivial task).
- `analyze-thread-jsonl.mts` is reused as-is for trace metrics; benchmark
  grading (did the tests pass) layers on top rather than replacing it.
