import type { ClassifierResult } from '@copse/llm/classifiers/types.ts'
import type { ModelUsage } from '@shared/types'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { recordUsageEvent } from '../storage/usage-ledger.ts'

/** Records usage for one classifier call: what a provider reports, attributed to its connection. */
export type RecordClassifierUsage = (model: string, usage: ModelUsage, provider?: string) => void

/**
 * Append a `classifier` event to the usage ledger. A call that reports no tokens
 * records nothing: a missing figure stays missing rather than becoming zero. A
 * call made inside a thread turn carries that thread and project.
 */
export const recordClassifierUsage: RecordClassifierUsage = (model, usage, provider) => {
  if (!usage.inputTokens && !usage.outputTokens) return
  const context = getThreadExecutionContext()
  recordUsageEvent({
    model,
    source: 'classifier',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(provider ? { provider } : {}),
    ...(context?.threadId ? { threadId: context.threadId } : {}),
    ...(context?.projectId ? { projectId: context.projectId } : {}),
  })
}

/** Record a result's reported tokens against the connection that served it. */
export function recordClassifierResultUsage(
  provider: string,
  result: ClassifierResult,
  record: RecordClassifierUsage = recordClassifierUsage,
): void {
  const { inputTokens = 0, outputTokens = 0 } = result.usage ?? {}
  if (!inputTokens && !outputTokens) return
  record(result.model, { inputTokens, outputTokens }, provider)
}
