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

import { DEFAULT_CLOUD_MODEL } from '@copse/llm/model-catalog.ts'

export const MODEL_COMPARISON_ENABLED_SETTING = 'modelComparisonEnabled'
export const MODEL_COMPARISON_AUTO_ON_REVIEW_SETTING = 'modelComparisonAutoOnReview'
export const COMPARISON_MODEL_A_SETTING = 'comparisonModelA'
export const COMPARISON_MODEL_B_SETTING = 'comparisonModelB'
export const COMPARISON_JUDGE_MODEL_SETTING = 'comparisonJudgeModel'

/** Default second reviewer and judge when the settings are left blank (a frontier Claude). */
export const DEFAULT_COMPARISON_MODEL_B = 'claude-opus-4-8'
export const DEFAULT_COMPARISON_JUDGE_MODEL = 'claude-opus-4-8'

export interface ComparisonModels {
  /** First reviewer (defaults to the current chat model). */
  a: string
  /** Second reviewer. */
  b: string
  /** Model that writes the comparison of A's and B's verdicts. */
  judge: string
}

/**
 * Resolve the three model ids from the (possibly blank) settings, falling back
 * so a run always has a sensible pair + judge: A → the current chat model, B and
 * the judge → a frontier default.
 */
export function resolveComparisonModels(opts: {
  modelA?: string | null
  modelB?: string | null
  judge?: string | null
  chatModel: string
}): ComparisonModels {
  const a = opts.modelA?.trim() || opts.chatModel
  const configuredB = opts.modelB?.trim()
  let b = configuredB || DEFAULT_COMPARISON_MODEL_B
  // When B falls back to its default and would collide with A, pick a different
  // frontier so the default-on experience isn't a silent no-op — e.g. an Opus
  // chat model (A) against the Opus default (B) would otherwise make A === B.
  // An *explicit* B === A is left alone: that is the user's own misconfiguration
  // and the distinct-reviewer check surfaces it.
  if (!configuredB && b === a) b = DEFAULT_CLOUD_MODEL
  const judge = opts.judge?.trim() || DEFAULT_COMPARISON_JUDGE_MODEL
  return { a, b, judge }
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
