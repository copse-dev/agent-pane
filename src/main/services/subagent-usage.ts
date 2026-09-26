import { AsyncLocalStorage } from 'node:async_hooks'
import type { ModelUsage } from '@shared/types'

// Subagents (explore, CI investigator, orchestration, custom agents) run nested
// inside the parent agent loop via executeTool. Their token usage is accumulated
// here during a run and folded into the parent thread total after the loop
// finishes (see agent-service.ts).
//
// The accumulator is async-local, not a module-global slot: two threads can run
// at once, and a shared slot let one run's start wipe the other's usage and
// credited each thread's subagents to whichever run read the total first. Each
// `runWithSubagentUsageScope` call owns a fresh accumulator that only the
// subagents started inside it can reach.
const usageStorage = new AsyncLocalStorage<ModelUsage>()

export function runWithSubagentUsageScope<T>(run: () => T): T {
  return usageStorage.run({ inputTokens: 0, outputTokens: 0 }, run)
}

/** The current scope's subagent usage; zero outside any scope. */
export function getAccumulatedSubagentUsage(): ModelUsage {
  const accumulated = usageStorage.getStore()
  return accumulated ? { ...accumulated } : { inputTokens: 0, outputTokens: 0 }
}

/**
 * Adds to the current run's accumulator. Outside a scope there is no run to
 * credit, so the usage is dropped rather than parked where another run could
 * pick it up.
 */
export function addSubagentUsage(usage: ModelUsage): void {
  const accumulated = usageStorage.getStore()
  if (!accumulated) return
  accumulated.inputTokens += usage.inputTokens
  accumulated.outputTokens += usage.outputTokens
  if (usage.cacheReadTokens !== undefined) {
    accumulated.cacheReadTokens = (accumulated.cacheReadTokens ?? 0) + usage.cacheReadTokens
  }
  if (usage.cacheCreationTokens !== undefined) {
    accumulated.cacheCreationTokens =
      (accumulated.cacheCreationTokens ?? 0) + usage.cacheCreationTokens
  }
}
