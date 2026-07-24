# Local-model loop kicking

Status: **proposed** — spec only, no code yet. Extends the existing loop-guard /
`stepBoundary` nudge system for small local models (Qwen, DeepSeek-Coder, etc.)
that circle harder and earlier than the frontier models the current thresholds
were tuned for.

## Why

The "kick it when it's going in circles" machinery already ships on `main` and is
model-agnostic:

- **Duplicate-explore guard** (`agent-loop-guards.ts`): fingerprints tool calls
  (`toolCallFingerprint`), and for the five read-only explore tools replaces an
  exact repeat's result with `DUPLICATE_TOOL_RESULT_PREFIX` instead of
  re-running it. Rolling window of the last `RECENT_FINGERPRINT_WINDOW = 16`
  calls. Fires on the first exact repeat, ungated.
- **Loop nudge** (`loopNudgeHook` → `shouldInjectLoopNudge`): once-per-run soft
  "stop spinning" pushed as a user turn, gated on conversation pressure ×
  tool-only steps.
- **Stuck-finalize** (`stuckFinalizeNudgeHook` → `shouldForceTextAnswer`):
  once-per-run forced tool-free turn when pressure is high.
- **Reasoning-runaway** (`reasoningRunawayHook` + `run-agent-loop.ts`): catches a
  pure-reasoning stream that trips the per-stream output cap, suppresses the
  normal truncation-continue, injects `REASONING_RUNAWAY_FORCE_ANSWER_NUDGE`,
  and gives up after `MAX_REASONING_RUNAWAY_STREAK = 2`.

Three gaps show up specifically with small local weights:

1. **Everything except the duplicate-explore guard is pressure-gated.** The
   escalation thresholds (`escalationThresholds`, `SOFT_NUDGE_FILL_RATIO = 0.7`,
   `FORCE_TEXT_FILL_RATIO = 0.85`) scale with conversation budget. A Qwen model
   that loops on step 3 of a near-empty context gets no loop nudge and no
   force-finalize — only the reasoning-runaway path can fire, and only if the
   stream actually hits the token cap.
2. **No reasoning-churn detection.** Duplicate _tool calls_ are fingerprinted,
   but nothing watches the _reasoning stream itself_ — not the volume of thinking
   before the model acts, not the backtrack/restart phrasing that dominates
   small-model loops, not near-duplicate reasoning blocks. It is caught only
   indirectly, once the per-stream output cap trips.
3. **Thresholds and streak limits are global constants.** `run-agent-loop.ts`
   already accepts per-run recovery knobs (`reasoningRunawayRecoveryOutputTokens`,
   `reasoningRunawayRecoveryNudge`, `reasoningRunawayTextToleranceChars`) but
   **nothing sets them** — no caller passes them today. They are an unwired seam.

## Design

Model-agnostic behavior stays the default. Local models opt into a tighter
profile; frontier models are byte-identical to today.

### 1. A loop-kicking profile on the capability catalog

Add an optional field to `LocalModelCapability` in
`packages/llm/src/local-model-catalog.ts`:

```ts
export interface LoopKickingProfile {
  /** Multiplier on the pressure-gated step thresholds (<1 = kick sooner). */
  stepThresholdScale?: number

  // Signal A — pre-action reasoning budget (volume, not wall-clock).
  /**
   * Kick once cumulative reasoning tokens since the last *productive* step
   * (a tool call OR a final answer) exceed this. Hardware-independent: a model
   * that thinks this much without acting is stuck whether it took 5s or 5min.
   */
  reasoningBudgetTokens?: number

  // Signal B — backtrack-marker density (lexical, model-family specific).
  /**
   * Restart/backtrack phrases this family emits while circling, matched
   * case-insensitively (e.g. "wait", "but wait", "let me reconsider").
   */
  backtrackMarkers?: readonly string[]
  /** Kick once marker hits within the rolling reasoning window reach this. */
  backtrackMarkerLimit?: number

  // Signal C — near-duplicate reasoning (structural backstop).
  /** Kick on N near-identical reasoning blocks (verbatim churn only). */
  reasoningRepeatLimit?: number

  // Escalation + recovery.
  /** Override MAX_REASONING_RUNAWAY_STREAK for this model. */
  maxReasoningRunawayStreak?: number
  /** Per-run recovery knobs forwarded to runAgentLoop. */
  recoveryOutputTokens?: number
  recoveryNudge?: string
  recoveryTextToleranceChars?: number
}
```

Seed conservative values for the Qwen / DeepSeek-Coder entries already in
`BASE_CATALOG`. Absent field = today's global constants (no behavior change).

A pure helper `loopKickingProfile(modelId): LoopKickingProfile | null` (sibling to
`localModelRoleHint`) resolves it, data-driven, no id matching in logic.

### 2. What "circling" looks like, and the signals we detect

Circling on small local models is rarely verbatim repetition — it is _semantic
churn_: the model re-opens a decision it already made, thinks at length, and
never acts. So the detector is three complementary signals, evaluated at the
step boundary and during the reasoning stream. All are cheap (string/counter
ops, no extra LLM calls), and for a profiled model **any one** tripping fires
the loop nudge regardless of pressure.

Each signal maps to a new `StreamCutReason` (extending
`packages/agent/src/stream-cut-record.ts`, which today has only
`reasoning_runaway_cap`), so every kick is persisted to `stream-stats.jsonl`
via the existing `recordStreamCut` path — reusing the cut-reasoning-to-stream-
stats infra that landed with #489. The measurement substrate already exists;
this plan adds detectors + cut reasons on top of it, and they become observable
for eval for free.

**Signal A — pre-action reasoning budget** (answers _"how much reasoning before
a tool call"_). New loop counter `reasoningTokensSinceAction`, reset to 0 on
every _productive_ step (a tool call **or** a final answer) and incremented each
stream by `streamReasoningChars`→tokens (the same estimate `StreamCutRecord`
already carries). When it crosses `reasoningBudgetTokens`, kick
(`cutReason: 'reasoning_budget'`). This is a **volume** budget, deliberately not
a timer — see below.

**Signal B — backtrack-marker density** (answers _"common terms Qwen uses when
it's circling"_). Qwen / QwQ / Qwen3-thinking / R1-family loops are dominated by
restart markers. Per-profile `backtrackMarkers` counted case-insensitively over
the rolling reasoning window; when hits reach `backtrackMarkerLimit`, kick
(`cutReason: 'backtrack_churn'`). Seed set for the Qwen entries: `wait`,
`but wait`, `hold on`, `actually`, `let me reconsider`, `let me re-examine`,
`alternatively`, `on second thought`, `hmm`. Markers are profile _data_, so
frontier models (no profile) are untouched and the list is tunable per family
with no code change. This catches the churn fingerprinting misses — lexically
varied but marker-dense.

**Signal C — near-duplicate reasoning** (structural backstop). The original
idea, demoted: `reasoningFingerprint(text)` — a normalized (whitespace-collapsed,
lowercased, length-capped) hash of a reasoning chunk over a short rolling window
(reuse the `recentFingerprints` pattern). N repeats → kick
(`cutReason: 'reasoning_repeat'`). Kept only for literal paragraph re-emission;
**insufficient alone**, because real circling seldom repeats verbatim.

**Escalation.** First trip → `loopNudgeHook` (soft kick, pushed as a user turn).
Repeated trips within the run reuse the existing reasoning-runaway streak /
give-up machinery, capped by `maxReasoningRunawayStreak`, ending in a forced
text answer.

**Why not a wall-clock timer.** Rejected. Local models are legitimately slow
(low tok/s on large weights), so wall-clock conflates "slow hardware" with
"stuck" and would false-kick a model making steady progress. Every signal above
is token / step / lexical — hardware-independent. The only time bound stays the
existing `runDeadline`.

Together these close gaps #1 and #2 without touching the frontier-model path,
because every threshold above is set only from a local profile.

### 3. Wire the profile through the call site

`shouldInjectLoopNudge` / `shouldForceTextAnswer` (`agent-loop-escalation.ts`)
gain an optional `thresholdScale` arg applied to `EscalationThresholds`. The
`stepBoundary` payload already carries the escalation input; thread the scale +
`reasoningRepeatLimit` in alongside it.

At the caller (`src/main/services/agent-service.ts:1152`, plus the three sibling
`runAgentLoop` callers — `post-turn-orchestration.ts`, `todo-worker-runner.ts`,
`run-subagent.ts`) the resolved `model` id already exists in scope. Resolve
`loopKickingProfile(model)` once and pass its fields into `runAgentLoop`,
populating the currently-dead recovery knobs.

## Non-goals

- No change to the duplicate-explore guard (already ungated and correct).
- No new UI — profiles are catalog data, not user settings, for v1.
- No provider-level detection heuristics; "is this a local model" is answered by
  catalog membership, consistent with the rest of `local-model-catalog.ts`.

## Testing

- Unit — `loopKickingProfile` resolution; and one test per signal:
  - **A**: `reasoningTokensSinceAction` resets on a tool call and on a final
    answer, and crossing `reasoningBudgetTokens` kicks.
  - **B**: marker counter is case-insensitive over the window; distinct-but-
    marker-dense text kicks, clean prose of the same length does not.
  - **C**: `reasoningFingerprint` normalization — near-identical texts collide,
    distinct ones don't; N repeats kick.
- Loop — extend `run-agent-loop.test.ts` / `agent-loop-escalation.test.ts`: each
  signal fires at low fill ratio for a profiled model and emits the matching
  `StreamCutReason`; a frontier model (no profile) stays byte-identical to
  current fixtures.

## Rollout

Profiles ship dormant (absent fields) except for the seeded Qwen /
DeepSeek-Coder entries, so the frontier path is provably unchanged. Widen
coverage by adding profile data as local-model loop behavior is observed — no
code change needed per model.
