import type { StreamChunk, Thread } from '@shared/types'
import { storageGet, storageSet } from './storage.ts'
import {
  buildUsageSummary,
  parseUsageEvents,
  pruneUsageEvents,
  type UsageSummary,
} from '@shared/usage/aggregate-usage.ts'
import {
  USAGE_EVENTS_STORAGE_KEY,
  type UsageRecordInput,
  type UsageEvent,
} from '@shared/usage/usage-event.ts'

function toUsageEvent(input: UsageRecordInput): UsageEvent {
  const { model, source, projectId, threadId, at, ...usage } = input
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
  })
}

function loadAllThreads(): Thread[] {
  const projects =
    (storageGet('projects') as Array<{ id: string }> | null)?.filter(
      (p) => typeof p.id === 'string' && p.id.length > 0,
    ) ?? []
  const threads: Thread[] = []
  for (const project of projects) {
    const raw = storageGet(`threads:${project.id}`)
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      if (typeof item === 'object' && item !== null && typeof (item as Thread).id === 'string') {
        threads.push(item as Thread)
      }
    }
  }
  return threads
}

export function getUsageSummary(): UsageSummary {
  const events = parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY))
  const threads = loadAllThreads()
  return buildUsageSummary(events, threads)
}

export function getUsageEventCount(): number {
  return parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY)).length
}
