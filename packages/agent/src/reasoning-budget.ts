/**
 * Per-step soft reasoning budget.
 *
 * A reasoning-dominated stream that reaches the soft budget with no tool call
 * and no visible answer is cut early. Unlike the hard-cap path, where the whole
 * stream is discarded and the model is told to start over, the cut converts the
 * thinking so far into progress: a bounded excerpt of it is carried into
 * history with an instruction to act on the best partial plan now.
 */
export interface ReasoningSoftBudget {
  /** Estimated reasoning tokens at which a tool-less stream is cut early. */
  tokens: number
  /** Max characters of the cut reasoning carried into the continuation message. */
  carryChars: number
  /** Max soft cuts in one run; afterwards the hard caps alone apply. */
  maxCutsPerRun: number
  /** Max soft cuts in a row without an intervening non-cut stream. */
  maxConsecutiveCuts: number
}

/**
 * Chosen from 76 Terminal-Bench streams (Qwen3.6-35B-A3B): completed steps have
 * p50 136 / p95 1,006 chars of reasoning (about 250 tokens), then nothing
 * between 1,101 and 3,982 chars; every runaway is 3,982+ chars. 768 tokens
 * (about 3K chars) leaves the whole healthy population untouched.
 */
export const DEFAULT_REASONING_SOFT_BUDGET_TOKENS = 768
export const DEFAULT_REASONING_SOFT_BUDGET_CARRY_CHARS = 1_200
export const DEFAULT_REASONING_SOFT_BUDGET_MAX_CUTS_PER_RUN = 6
export const DEFAULT_REASONING_SOFT_BUDGET_MAX_CONSECUTIVE_CUTS = 2

export const REASONING_BUDGET_CARRY_FORWARD_HOOK_ID = 'reasoning-budget-carry-forward'

export function defaultReasoningSoftBudget(
  tokens: number = DEFAULT_REASONING_SOFT_BUDGET_TOKENS,
): ReasoningSoftBudget {
  return {
    tokens,
    carryChars: DEFAULT_REASONING_SOFT_BUDGET_CARRY_CHARS,
    maxCutsPerRun: DEFAULT_REASONING_SOFT_BUDGET_MAX_CUTS_PER_RUN,
    maxConsecutiveCuts: DEFAULT_REASONING_SOFT_BUDGET_MAX_CONSECUTIVE_CUTS,
  }
}

export function validateReasoningSoftBudget(budget: ReasoningSoftBudget): void {
  const values = [budget.tokens, budget.carryChars, budget.maxCutsPerRun, budget.maxConsecutiveCuts]
  if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('Reasoning soft budget limits must be positive integers.')
  }
}

/**
 * A bounded excerpt of cut reasoning: the opening (what the model set out to
 * work out) and the tail (where its latest conclusions are). Whitespace is
 * collapsed so the excerpt spends its budget on content.
 */
export function excerptReasoningForCarryForward(reasoning: string, carryChars: number): string {
  const collapsed = reasoning.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= carryChars) return collapsed
  const marker = ' [...] '
  if (carryChars <= marker.length) return collapsed.slice(-carryChars)
  const room = carryChars - marker.length
  const headChars = Math.floor(room / 3)
  const tailChars = room - headChars
  const head = collapsed.slice(0, headChars).trimEnd()
  const tail = collapsed.slice(collapsed.length - tailChars).trimStart()
  return `${head}${marker}${tail}`
}

/**
 * The continuation message pushed after a soft cut. `cutNumber` is how many
 * soft cuts in a row have now happened; the second asks for a tool call first.
 */
export function buildReasoningBudgetCarryForwardNudge(
  reasoning: string,
  options: { carryChars: number; cutNumber: number },
): string {
  const excerpt = excerptReasoningForCarryForward(reasoning, options.carryChars)
  const lines = [
    'Your thinking for this step reached its budget before you called a tool, so it was cut short.',
    'Notes from your own thinking so far (truncated):',
    excerpt ? `"""\n${excerpt}\n"""` : '(none)',
    'Treat these notes as your working plan. Do not re-derive them or keep analysing; act now by calling a tool for the next concrete step, and adjust later from real output rather than from more thinking.',
  ]
  if (options.cutNumber > 1) {
    lines.push('Your next response must begin with a tool call.')
  }
  return lines.join('\n\n')
}
