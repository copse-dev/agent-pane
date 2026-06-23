import type { Thread } from '@shared/types'
import { storageGet, storageUpdate } from './storage.ts'
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

export async function recordUsageEvent(input: UsageRecordInput): Promise<void> {
  if (!input.inputTokens && !input.outputTokens) return
  const event = toUsageEvent(input)
  await storageUpdate(USAGE_EVENTS_STORAGE_KEY, (raw) => {
    const existing = parseUsageEvents(raw)
    const next = pruneUsageEvents([...existing, event])
    return next
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
