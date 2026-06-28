import type { UsageDelta } from '@shared/types'
import type { UsageRecordInput } from './usage-event.ts'

/** Build a ledger record from an agent usage delta/chunk. */
export function usageRecordFromAgentDelta(
  threadId: string,
  delta: Pick<
    UsageDelta,
    'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
  >,
  projectId: string | null | undefined,
): UsageRecordInput {
  return {
    model: delta.model,
    source: 'agent',
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    threadId,
    ...(projectId ? { projectId } : {}),
    ...(delta.cacheReadTokens !== undefined ? { cacheReadTokens: delta.cacheReadTokens } : {}),
    ...(delta.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: delta.cacheCreationTokens }
      : {}),
  }
}
