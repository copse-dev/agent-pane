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
2. **No repeated-*reasoning* detection.** Duplicate *tool calls* are
   fingerprinted; repeated near-identical *reasoning/assistant text* — a classic
   small-model failure — is not caught except indirectly via the per-stream cap.
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
  /** Fire the loop nudge on N identical-reasoning repeats, independent of pressure. */
  reasoningRepeatLimit?: number
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

### 2. Early-firing repeated-reasoning detector

New primitive in `agent-loop-guards.ts`, symmetric with the tool fingerprint:

- `reasoningFingerprint(text)` — normalized (whitespace-collapsed, lowercased,
  length-capped) hash of an assistant/reasoning chunk.
- A short rolling window on the loop state (reuse the `recentFingerprints`
  pattern). When the same reasoning fingerprint recurs `reasoningRepeatLimit`
  times, the `loopNudgeHook` fires **regardless of pressure**.

This makes the loop nudge reachable early — closing gap #1 and #2 together —
without touching the frontier-model path, because `reasoningRepeatLimit` is only
set from a local profile.

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

- Unit: `loopKickingProfile` resolution; `reasoningFingerprint` normalization
  (near-identical texts collide, distinct ones don't); `shouldInjectLoopNudge`
  with `thresholdScale` and with `reasoningRepeatLimit` at zero pressure.
- Loop: extend `run-agent-loop.test.ts` / `agent-loop-escalation.test.ts` — a
  local profile kicks on repeated reasoning at low fill ratio; a frontier model
  (no profile) stays byte-identical to current fixtures.

## Rollout

Profiles ship dormant (absent fields) except for the seeded Qwen /
DeepSeek-Coder entries, so the frontier path is provably unchanged. Widen
coverage by adding profile data as local-model loop behavior is observed — no
code change needed per model.
