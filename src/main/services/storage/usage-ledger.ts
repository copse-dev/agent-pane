import { loadAllProjectThreads } from '../thread-store.ts'
import type { StreamChunk } from '@shared/types'
import { storageGet, storageSet } from './storage.ts'
import {
  buildUsageSummary,
  parseUsageEvents,
  pruneUsageEvents,
  type UsageSummary,
} from '@shared/usage/aggregate-usage.ts'
import { resolveModelPricing } from '../providers/model-pricing-store.ts'
import {
  USAGE_EVENTS_STORAGE_KEY,
  type UsageRecordInput,
  type UsageEvent,
} from '@shared/usage/usage-event.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'

function toUsageEvent(input: UsageRecordInput): UsageEvent {
  const { model, source, projectId, threadId, at, estimated, ...usage } = input
  if (!usage.inputTokens && !usage.outputTokens) {
    throw new Error('Usage record must include at least one non-zero token count')
  }
  return {
    at: at ?? Date.now(),
    model,
    source,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(projectId ? { projectId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(estimated ? { estimated: true } : {}),
  }
}

/** Append one usage event synchronously (safe for concurrent main-process recorders). */
export function recordUsageEvent(input: UsageRecordInput): void {
  if (!input.inputTokens && !input.outputTokens) return
  const event = toUsageEvent(input)
  const existing = parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY))
  storageSet(USAGE_EVENTS_STORAGE_KEY, pruneUsageEvents([...existing, event]))
}

/** Record token usage from an agent run usage chunk (main process). */
export function recordAgentUsageChunk(
  threadId: string,
  chunk: Extract<StreamChunk, { type: 'usage' }>,
): void {
  if (!chunk.inputTokens && !chunk.outputTokens) return
  const executionContext = getThreadExecutionContext()
  const projectId =
    executionContext?.threadId === threadId
      ? executionContext.projectId
      : storageGet('activeProjectId')
  recordUsageEvent({
    model: chunk.model,
    source: chunk.usageSource === 'advisor' ? 'advisor' : 'agent',
    inputTokens: chunk.inputTokens,
    outputTokens: chunk.outputTokens,
    threadId,
    ...(typeof projectId === 'string' && projectId.length > 0 ? { projectId } : {}),
    ...(chunk.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.cacheReadTokens } : {}),
    ...(chunk.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: chunk.cacheCreationTokens }
      : {}),
    ...(chunk.estimated ? { estimated: true } : {}),
  })
}

export async function getUsageSummary(): Promise<UsageSummary> {
  const events = parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY))
  const threads = await loadAllProjectThreads()
  return buildUsageSummary(events, threads, Date.now(), resolveModelPricing())
}

export function getUsageEventCount(): number {
  return parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY)).length
}
