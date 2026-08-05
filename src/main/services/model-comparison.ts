/**
 * Model comparison harness (experimental, opt-in). Runs the working-diff review
 * through *two* models independently, then asks a *judge* model to compare their
 * verdicts — where they agree, where they disagree, what each caught that the
 * other missed, and an overall recommendation. Surfaced as a single card in the
 * conversation, mirroring the post-turn review card.
 *
 * Because a run fires up to three model inferences (two reviewers + a judge), it
 * can be expensive. When any of the chosen models is billable we ask for
 * approval first (with a "remember for this session" option); free/local pairs
 * run silently. The trigger can be automatic (as part of the post-turn review)
 * or manual (the `compare_models` tool).
 *
 * This module is pure (no I/O, no settings read, no provider calls) so it is easy
 * to unit-test. The run-scoped provider/registry wiring lives in
 * model-comparison-runner.ts and the tool gating in registry-bootstrap.ts.
 */

import {
  BEST_INTELLECT_MODEL_SELECTOR,
  BEST_VALUE_MODEL_SELECTOR,
} from '@copse/llm/dynamic-model.ts'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'

// The former `MODEL_COMPARISON_ENABLED_SETTING` (top-level
// `modelComparisonEnabled`) was retired in P5: the pack toggle
// (`copse.model-comparison`) is now the atomic master switch consulted by the
// tool registration in `registry-bootstrap.ts` and the auto-on-review trigger
// in `agent-service.ts` / `isAutoComparisonEnabled()`.
//
// The three model choices (reviewer A / reviewer B / judge) are now the pack's
// own `model` setting fields (see `model-comparison-pack.ts`), read by
// `model-comparison-runner.ts`; the former top-level `comparisonModel*` store
// keys are retired. The `modelComparisonAutoOnReview` opt-in stays top-level.
export const MODEL_COMPARISON_AUTO_ON_REVIEW_SETTING = 'modelComparisonAutoOnReview'

/**
 * Defaults when a setting is left blank — dynamic selections, not pinned ids,
 * kept equal to the constants on the Electron-free pack side. Reviewer B and the
 * judge both reach for the most capable model available; they are expanded
 * against a single candidate pool (`resolveDistinctDynamicModelIds`), which is
 * what stops one rule used twice from naming one model twice.
 *
 * Reviewer A has no rule of its own: blank means the model this chat is running
 * on. `DEFAULT_COMPARISON_MODEL_A` covers only the case where there isn't one.
 */
export const DEFAULT_COMPARISON_MODEL_A = BEST_VALUE_MODEL_SELECTOR
export const DEFAULT_COMPARISON_MODEL_B = BEST_INTELLECT_MODEL_SELECTOR
export const DEFAULT_COMPARISON_JUDGE_MODEL = BEST_INTELLECT_MODEL_SELECTOR

export interface ComparisonModels {
  /** First reviewer (defaults to the current chat model). */
  a: string
  /** Second reviewer. */
  b: string
  /** Model that writes the comparison of A's and B's verdicts. */
  judge: string
}

/**
 * Fill in the three *selections* from the (possibly blank) settings. The result
 * may hold dynamic selectors; expanding them into concrete, distinct model ids
 * is `resolveModelsFromSettings`' job in the runner, which is also where any
 * collision between them is resolved.
 *
 * A blank reviewer A still means "the current chat model" — that is the one
 * choice where the user's live context is a better answer than any rule.
 */
export function resolveComparisonModels(opts: {
  modelA?: string | null
  modelB?: string | null
  judge?: string | null
  chatModel: string
}): ComparisonModels {
  return {
    a: nonEmptyStringOr(opts.modelA?.trim(), opts.chatModel || DEFAULT_COMPARISON_MODEL_A),
    b: nonEmptyStringOr(opts.modelB?.trim(), DEFAULT_COMPARISON_MODEL_B),
    judge: nonEmptyStringOr(opts.judge?.trim(), DEFAULT_COMPARISON_JUDGE_MODEL),
  }
}

/**
 * A comparison is only worth running when the two reviewers differ — two
 * identical models produce two identical reviews and nothing to compare.
 */
export function comparisonReviewersDistinct(models: ComparisonModels): boolean {
  return models.a !== models.b
}

/**
 * Whether to prompt for approval before spending money: true when *any* of the
 * three models is billable. `isPaid` is injected so this stays pure/testable —
 * the caller supplies the local-vs-billable classification.
 */
export function comparisonNeedsApproval(
  models: ComparisonModels,
  isPaid: (model: string) => boolean,
): boolean {
  return isPaid(models.a) || isPaid(models.b) || isPaid(models.judge)
}

/** The distinct billable models in a run, for the approval prompt body. */
export function billableComparisonModels(
  models: ComparisonModels,
  isPaid: (model: string) => boolean,
): string[] {
  const seen = new Set<string>()
  for (const m of [models.a, models.b, models.judge]) {
    if (isPaid(m)) seen.add(m)
  }
  return [...seen]
}

/** Short intro for the comparison approval when the renderer shows model pickers. */
export function comparisonApprovalPickerIntro(): string {
  return 'Each reviewer independently reads the working diff; a judge compares their verdicts.'
}

/** Human-readable body for the "spend money on a comparison?" approval prompt. */
export function comparisonApprovalBody(
  models: ComparisonModels,
  isPaid: (model: string) => boolean,
): string {
  const billable = billableComparisonModels(models, isPaid)
  return [
    'Run a two-model comparison of the working diff?',
    '',
    `• Reviewer A: ${models.a}`,
    `• Reviewer B: ${models.b}`,
    `• Judge: ${models.judge}`,
    '',
    billable.length
      ? `This makes billable calls to: ${billable.join(', ')}.`
      : 'All chosen models are local (no charge).',
  ].join('\n')
}

export const COMPARISON_JUDGE_PREAMBLE =
  'You are comparing two independent code reviews of the same working diff, ' +
  'each produced by a different model. Do NOT re-review the code yourself. ' +
  'Produce a concise comparison the user can read at a glance:\n' +
  '- **Agree**: concerns both reviews raised.\n' +
  '- **Disagree**: points where they conflict, and which is more likely right.\n' +
  '- **Only A / Only B**: findings unique to one review.\n' +
  '- **Bottom line**: one line on which review to trust more and what to fix first.\n' +
  'Cite file paths where the reviews did. Keep it under ~200 words.'

/** Build the judge's prompt from the two reviewers' verdicts. */
export function buildComparisonJudgePrompt(
  parentGoal: string,
  models: ComparisonModels,
  reviewA: string,
  reviewB: string,
): string {
  return [
    COMPARISON_JUDGE_PREAMBLE,
    '',
    `# Task under review`,
    parentGoal,
    '',
    `# Review A — ${models.a}`,
    reviewA.trim() || '(no output)',
    '',
    `# Review B — ${models.b}`,
    reviewB.trim() || '(no output)',
    '',
    'Now write the comparison.',
  ].join('\n')
}
