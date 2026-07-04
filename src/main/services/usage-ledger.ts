import { loadAllProjectThreads } from './thread-store.ts'
import type { StreamChunk } from '@shared/types'
import { storageGet, storageSet } from './storage.ts'
import {
  buildUsageSummary,
  parseUsageEvents,
  pruneUsageEvents,
  type UsageSummary,
} from '@shared/usage/aggregate-usage.ts'
import { extraProviderPricingMap } from '@shared/llm/extra-providers.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import {
  USAGE_EVENTS_STORAGE_KEY,
  type UsageRecordInput,
  type UsageEvent,
} from '@shared/usage/usage-event.ts'

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

function isDuplicateEvent(existing: UsageEvent[], event: UsageEvent): boolean {
  const last = existing.at(-1)
  if (!last) return false
  return (
    last.source === event.source &&
    last.threadId === event.threadId &&
    last.model === event.model &&
    last.inputTokens === event.inputTokens &&
    last.outputTokens === event.outputTokens &&
    (last.cacheReadTokens ?? 0) === (event.cacheReadTokens ?? 0) &&
    (last.cacheCreationTokens ?? 0) === (event.cacheCreationTokens ?? 0) &&
    Math.abs(event.at - last.at) < 250
  )
}

/** Append one usage event synchronously (safe for concurrent IPC handlers on the same key). */
export function recordUsageEvent(input: UsageRecordInput): void {
  if (!input.inputTokens && !input.outputTokens) return
  const event = toUsageEvent(input)
  const existing = parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY))
  if (isDuplicateEvent(existing, event)) return
  storageSet(USAGE_EVENTS_STORAGE_KEY, pruneUsageEvents([...existing, event]))
}

/** Record token usage from an agent run usage chunk (main process). */
export function recordAgentUsageChunk(
  threadId: string,
  chunk: Extract<StreamChunk, { type: 'usage' }>,
): void {
  if (!chunk.inputTokens && !chunk.outputTokens) return
  const projectId = storageGet('activeProjectId')
  recordUsageEvent({
    model: chunk.model,
    source: 'agent',
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

export function getUsageSummary(): UsageSummary {
  const events = parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY))
  const threads = loadAllProjectThreads()
  return buildUsageSummary(
    events,
    threads,
    Date.now(),
    extraProviderPricingMap(getResolvedExtraProviders()),
  )
}

export function getUsageEventCount(): number {
  return parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY)).length
}
