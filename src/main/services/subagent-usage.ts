import { AsyncLocalStorage } from 'node:async_hooks'
import type { ModelUsage } from '@shared/types'

// One scope covers the admitted turn, including explicit pre-invocation and
// parent continuations. Each child records its resolved model, not the parent's
// explore route. Concurrent turns cannot reset or collect one another's usage.
const usageStorage = new AsyncLocalStorage<Map<string, ModelUsage>>()

export function runWithSubagentUsageScope<T>(run: () => T): T {
  return usageStorage.run(new Map(), run)
}

function sumUsage(total: ModelUsage, usage: ModelUsage): void {
  total.inputTokens += usage.inputTokens
  total.outputTokens += usage.outputTokens
  if (usage.cacheReadTokens !== undefined) {
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens
  }
  if (usage.cacheCreationTokens !== undefined) {
    total.cacheCreationTokens = (total.cacheCreationTokens ?? 0) + usage.cacheCreationTokens
  }
}

/** A snapshot, so consumers cannot change another child's accounting. */
export function getSubagentUsageByModel(): Map<string, ModelUsage> {
  return new Map(
    [...(usageStorage.getStore() ?? [])].map(([model, usage]) => [model, { ...usage }]),
  )
}

/** The current turn's subagent usage; zero outside any scope. */
export function getAccumulatedSubagentUsage(): ModelUsage {
  const total: ModelUsage = { inputTokens: 0, outputTokens: 0 }
  for (const usage of usageStorage.getStore()?.values() ?? []) sumUsage(total, usage)
  return total
}

/** Outside a turn there is no run to credit; never park usage for a later run. */
export function addSubagentUsage(model: string, usage: ModelUsage): void {
  const accumulated = usageStorage.getStore()
  if (!accumulated) return
  const total = accumulated.get(model) ?? { inputTokens: 0, outputTokens: 0 }
  sumUsage(total, usage)
  accumulated.set(model, total)
}
