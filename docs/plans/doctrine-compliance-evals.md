# Doctrine compliance evals

Tracking: proposed as [#744](https://github.com/copse-dev/agent-pane/issues/744) in the
[#743](https://github.com/copse-dev/agent-pane/pull/743) follow-up list (doctrine compliance
evals — incl. ablation-testing prompt sections like the tool list).

Status: **Phase 1 landed.** Deterministic transcript scoring and prompt-section ablation
pins run in the per-PR unit tier. Model-backed ablation arms remain nightly/label-gated
(same cost posture as Phase 3 of [`industry-benchmarks.md`](industry-benchmarks.md)).

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

## Phase 2 — model-backed ablation (nightly / label-gated)

Not in the per-PR path. Same harness posture as industry-benchmarks Phase 3:

- Fix a small task subset and a local/cloud model.
- Run N repeats per arm with one prompt section omitted (`buildAblatedBasePrompt`).
- Flagship first arm: **omit `tools`** (the tool list) vs full prompt — does the doctrine
  - tool-choice text still steer tool use, or does the enumerated list carry the behavior?
- Report solve-rate / doctrine-pass-rate / tokens-per-solve deltas; treat as trends, never
  PR gates.

## Non-goals

- LLM-as-judge inside the per-PR corpus (fixtures + heuristics only).
- Replacing `agent-run-eval` UI-in-the-loop scenarios — those stay for behavioral issues
  that need the Electron surface; doctrine scoring composes with them via `analyze:thread`.
- Per-provider prompt adapters (#750) or runtime reminders (#745) — separate follow-ups
  from the #743 list.
