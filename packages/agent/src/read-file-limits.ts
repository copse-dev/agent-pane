/** Upper bounds regardless of context (safety ceiling). */
export const READ_FILE_LIMITS_CEILING = {
  maxLines: 150,
  maxChars: 12_000,
} as const

/** Share of the run conversation budget allowed in one read_file result (~chars). */
export const READ_FILE_BUDGET_FRACTION = 0.12

/** Subagents get a larger share of their fresh context for read_file results. */
export const SUBAGENT_READ_FILE_BUDGET_FRACTION = 0.4

export const CHARS_PER_TOKEN_ESTIMATE = 4

export interface ReadFileLimits {
  maxLines: number
  maxChars: number
}

function readFileLimitsFromBudgetFraction(
  conversationBudgetTokens: number,
  fraction: number,
): ReadFileLimits {
  const budget = Math.max(1, Math.floor(conversationBudgetTokens))
  const maxChars = Math.min(
    READ_FILE_LIMITS_CEILING.maxChars,
    Math.max(3000, Math.floor(budget * CHARS_PER_TOKEN_ESTIMATE * fraction)),
  )
  const maxLines = Math.min(
    READ_FILE_LIMITS_CEILING.maxLines,
    Math.max(40, Math.floor(maxChars / 80)),
  )
  return { maxLines, maxChars }
}

export function readFileLimitsFromConversationBudget(
  conversationBudgetTokens: number,
): ReadFileLimits {
  return readFileLimitsFromBudgetFraction(conversationBudgetTokens, READ_FILE_BUDGET_FRACTION)
}

export function readFileLimitsForSubagent(conversationBudgetTokens: number): ReadFileLimits {
  return readFileLimitsFromBudgetFraction(
    conversationBudgetTokens,
    SUBAGENT_READ_FILE_BUDGET_FRACTION,
  )
}

export function formatReadFileLimitHint(limits: ReadFileLimits): string {
  return `capped at ${String(limits.maxLines)} lines and ~${limits.maxChars.toLocaleString()} characters per call for this run`
}
