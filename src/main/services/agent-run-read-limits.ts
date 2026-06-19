import {
  readFileLimitsFromConversationBudget,
  READ_FILE_LIMITS_CEILING,
  type ReadFileLimits,
} from '@shared/agent/read-file-limits.ts'

let active: ReadFileLimits | null = null

export function setAgentRunReadFileLimits(conversationBudgetTokens: number): void {
  active = readFileLimitsFromConversationBudget(conversationBudgetTokens)
}

export function clearAgentRunReadFileLimits(): void {
  active = null
}

export function getAgentRunReadFileLimits(): ReadFileLimits {
  return active ?? READ_FILE_LIMITS_CEILING
}
