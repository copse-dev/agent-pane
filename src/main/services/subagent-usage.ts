import type { ModelUsage } from '@shared/types'

// Subagents (explore, CI investigator) run nested inside the parent agent loop
// via executeTool. Their token usage is accumulated here during a run and folded
// into the parent thread total after the loop finishes (see agent-service.ts).
let accumulatedUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 }

export function resetSubagentUsage(): void {
  accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
}

export function getAccumulatedSubagentUsage(): ModelUsage {
  return accumulatedUsage
}

export function addSubagentUsage(usage: ModelUsage): void {
  accumulatedUsage.inputTokens += usage.inputTokens
  accumulatedUsage.outputTokens += usage.outputTokens
  if (usage.cacheReadTokens !== undefined) {
    accumulatedUsage.cacheReadTokens =
      (accumulatedUsage.cacheReadTokens ?? 0) + usage.cacheReadTokens
  }
  if (usage.cacheCreationTokens !== undefined) {
    accumulatedUsage.cacheCreationTokens =
      (accumulatedUsage.cacheCreationTokens ?? 0) + usage.cacheCreationTokens
  }
}
