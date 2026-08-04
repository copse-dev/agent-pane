# Doctrine compliance evals

Tracking: proposed as [#744](https://github.com/copse-dev/agent-pane/issues/744) in the
[#743](https://github.com/copse-dev/agent-pane/pull/743) follow-up list (doctrine compliance
evals — incl. ablation-testing prompt sections like the tool list).

Status: **Phase 2 implemented.** Deterministic transcript scoring and prompt-section
ablation pins run in the per-PR unit tier. The model-backed matrix runs through
`npm run eval:doctrine` on nightly/label-gated infrastructure (same cost posture as
Phase 3 of [`industry-benchmarks.md`](industry-benchmarks.md)).

## Why

[#743](https://github.com/copse-dev/agent-pane/pull/743) put a model-agnostic working-style
doctrine (`SHARED_WORKING_STYLE`) into the base system prompt. Without evals, that text is
an unmeasured assertion: we cannot tell whether the doctrine moves behavior, which bullets
earn their tokens, or whether the surrounding tool-list / tool-choice sections are doing
more of the work than the doctrine itself.

This plan is the doctrine-specific slice of the broader "hold the model constant and vary
the plumbing" program in [`industry-benchmarks.md`](industry-benchmarks.md).

## What shipped (Phase 1 — deterministic, per-PR)

1. **Composable prompt sections** (`src/main/services/agent-prompt-sections.ts`)
   - Named sections: `preamble`, `tools`, `workspace`, `openEnded`, `modifyingFiles`,
     `toolChoice`, `workingStyle`, `gitBranchSafety`.
   - `assemblePromptFromSections(sections, omit?)` builds the production prompt or an
     ablation arm. Full assembly is byte-identical to `BASE_SYSTEM_PROMPT` /
     `BASE_SYSTEM_PROMPT_DIRECT_READS`.
   - Pins in `src/main/services/agent-prompt-ablation.test.ts` (omit tools, omit
     workingStyle, omit each section once).

2. **Doctrine compliance scorer** (`src/shared/agent/doctrine-compliance.ts`)
   - Pure heuristics over a finished-turn transcript:
     `leadWithOutcome`, `readableOverTerse`, `questionVsRequest`, `faithfulReporting`,
     `scopeDiscipline`, `noNarratingComments`.
   - Fixture corpus: `tests/fixtures/doctrine-compliance-corpus.json`, enforced by
     `src/shared/agent/doctrine-compliance.corpus.test.ts`.

3. **Analyzer hook** (`scripts/analyze-thread-jsonl.mts`)
   - Always emits a `doctrine` report on thread JSONL.
   - Scenarios may set `expect.requireDoctrineCompliance: true` (plus optional
     `userIntent` / `inScopePaths`) to fail the analyze run on violations.

## What shipped (Phase 2 — model-backed, nightly / label-gated)

The headless runner keeps the model, tasks, and tool schemas fixed while changing one
prompt section at a time:

- `npm run eval:doctrine -- --provider <id>` supports `lmstudio`, `openai`, `anthropic`,
  `openrouter`, and the deterministic `mock` harness self-test.
- The default matrix is `full` vs `omit-tools`; `--sections tools,workingStyle` adds one
  independent omission arm per named section, and `--repeats N` controls repetition.
- The fixed task subset covers a scoped bug fix, a question that must not edit, and faithful
  reporting of a known failing command. Model-issued shell commands are accepted only when
  the task manifest explicitly allows the exact command.
- Each run writes JSONL traces plus `report.json` and `report.md`, including solve rate,
  doctrine pass rate, per-rule pass rates, tokens per solve, and deltas against the full arm.
- `benchmarks/doctrine/doctrine-baseline.json` stores reviewed provider/model snapshots;
  update one deliberately with `--update-baseline` after inspecting the report.
- CI runs the mock full/omit-tools matrix as a deterministic harness check. A separate
  `doctrine-eval-model` job runs three real-model repeats nightly or when a PR has the
  `bench-doctrine` label and `LM_EVAL_RUNNER` is configured. It uploads trend artifacts and
  is deliberately outside the merge gate.

Example local-model run:

```bash
LM_STUDIO_MODEL=<model-id> LM_STUDIO_API_KEY=<key> \
  npm run eval:doctrine -- --provider lmstudio --repeats 3 --sections tools
```

Initial baseline (`qwen/qwen3.6-35b-a3b`, 2026-07-30): both arms solved 9/9 attempts
and passed the doctrine 9/9. The full arm used approximately 1,143 tokens per solve;
`omit-tools` used approximately 1,024 (-119). The endpoint did not report usage, so the
token figures are marked as estimates; this first run shows no behavioral lift from the
enumerated tool-list prose on the three-task subset.

## Follow-on use of the evidence

- Refresh reviewed baselines intentionally when a model or prompt changes materially; never
  auto-commit a noisy nightly result.
- Expand the task subset or ablate another section only when a concrete product question
  needs it; avoid turning the matrix into an unowned leaderboard.
- Use measured per-rule weaknesses to drive per-provider adapters (#750) and compare runtime
  reminders (#745) on/off. Those product features remain separate follow-ups.

## Non-goals

- LLM-as-judge inside the per-PR corpus (fixtures + heuristics only).
- Replacing `agent-run-eval` UI-in-the-loop scenarios — those stay for behavioral issues
  that need the Electron surface; doctrine scoring composes with them via `analyze:thread`.
- Per-provider prompt adapters (#750) or runtime reminders (#745) — this harness measures
  them, but those product features remain separate follow-ups from the #743 list.
