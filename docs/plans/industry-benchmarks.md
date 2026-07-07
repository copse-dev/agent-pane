# Industry benchmarks as plumbing evals

Tracking: [#752](https://github.com/copse-dev/agent-pane/issues/752)

Status: **Phase 1 landed, Phase 2 scaffolded.** Phase 1's deterministic
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
Phases 3–4 remain. This doc maps where public agent benchmarks
(SWE-bench, Terminal-Bench, BFCL, TAU-bench, RULER-style long-context
suites, MCP conformance suites) plug into the harness we already have,
and what each one buys the _plumbing_ specifically.

## The framing: benchmarks as harness evals, not model evals

Leaderboards use benchmarks to rank models. That is not the opportunity here —
Copse doesn't train models. The opportunity is the inverse experiment: **hold
the model constant and vary the plumbing.** Copse owns an unusually deep stack
of harness machinery whose value is currently asserted, not measured:

- loop guards, duplicate-explore detection, finalize nudges, todo gating
  (`agent-loop-guards`, `agent-loop-escalation`)
- in-loop compaction and context accounting (`trim-history`,
  `context-breakdown`, `working-brief`)
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
| **Terminal-Bench**                         | node-pty terminal tooling, shell-command permission path          | nightly, self-hosted                    |
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

### Phase 3 — plumbing A/B mode

The payoff phase. Add a flag matrix to the Phase 2 harness so one invocation
runs the same model over the same task subset with a plumbing feature toggled:
trim-history on/off, todo gating on/off, duplicate-explore guard on/off,
working-brief on/off. Report the delta in solve rate and tokens-per-solve.

- Non-determinism is handled statistically, not wished away: fixed subsets,
  N repeats per arm, report ranges; treat results as trends, never PR gates.
- This converts "we believe the finalize nudge helps" into a measured claim,
  and — just as valuable — licenses _deleting_ guards that measure as neutral.
  The loop machinery only stays honest if features must pay rent.

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

- `wdio.eval.conf.ts` / `agent-run-eval` stay the UI-in-the-loop harness for
  behavioral issues; the bench harness is headless and outcome-graded.
- `validate:local-agent` becomes the smoke test for the Phase 2 harness's
  loop-hosting seam (same headless setup, trivial task).
- `analyze-thread-jsonl.mts` is reused as-is for trace metrics; benchmark
  grading (did the tests pass) layers on top rather than replacing it.
