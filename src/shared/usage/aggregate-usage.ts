import type { ModelUsage, Thread } from '@shared/types'
import { isLocalModel } from '@shared/llm/estimate-cost.ts'
import { costForModelUsage } from '@shared/llm/estimate-cost.ts'
import type { UsageEvent } from './usage-event.ts'

export const DAY_MS = 24 * 60 * 60 * 1000
export const MONTH_MS = 30 * DAY_MS
export const PERIOD_90D_MS = 90 * DAY_MS

export interface ModelUsageBreakdown {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  estimatedCostUsd: number
  isLocal: boolean
}

export interface UsagePeriodSummary {
  totalCostUsd: number
  cloudModels: ModelUsageBreakdown[]
  localModels: ModelUsageBreakdown[]
  totalInputTokens: number
  totalOutputTokens: number
}

export interface UsageSummary {
  day: UsagePeriodSummary
  month: UsagePeriodSummary
  period90d: UsagePeriodSummary
  allTime: UsagePeriodSummary
  /** Earliest recorded event timestamp, or null when the ledger is empty. */
  trackingStartedAt: number | null
}

function mergeModelUsage(prev: ModelUsage, delta: ModelUsage): ModelUsage {
  const next: ModelUsage = {
    inputTokens: prev.inputTokens + delta.inputTokens,
    outputTokens: prev.outputTokens + delta.outputTokens,
  }
  if (delta.cacheReadTokens !== undefined || prev.cacheReadTokens !== undefined) {
    next.cacheReadTokens = (prev.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0)
  }
  if (delta.cacheCreationTokens !== undefined || prev.cacheCreationTokens !== undefined) {
    next.cacheCreationTokens = (prev.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0)
  }
  return next
}

export function mergeUsageByModel(
  base: Record<string, ModelUsage>,
  model: string,
  delta: ModelUsage,
): Record<string, ModelUsage> {
  const prev = base[model] ?? { inputTokens: 0, outputTokens: 0 }
  return { ...base, [model]: mergeModelUsage(prev, delta) }
}

export function aggregateEventsByModel(
  events: UsageEvent[],
  sinceMs: number,
  now = Date.now(),
): Record<string, ModelUsage> {
  const cutoff = now - sinceMs
  let byModel: Record<string, ModelUsage> = {}
  for (const event of events) {
    if (event.at < cutoff) continue
    byModel = mergeUsageByModel(byModel, event.model, event)
  }
  return byModel
}

export function aggregateThreadUsage(threads: Thread[]): Record<string, ModelUsage> {
  let byModel: Record<string, ModelUsage> = {}
  for (const thread of threads) {
    const usage = thread.usage
    if (usage.byModel && Object.keys(usage.byModel).length > 0) {
      for (const [model, modelUsage] of Object.entries(usage.byModel)) {
        byModel = mergeUsageByModel(byModel, model, modelUsage)
      }
      continue
    }
    if (!usage.inputTokens && !usage.outputTokens) continue
    // Legacy threads without per-model breakdown cannot be attributed.
  }
  return byModel
}

function toBreakdown(model: string, usage: ModelUsage): ModelUsageBreakdown {
  const isLocal = isLocalModel(model)
  return {
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    estimatedCostUsd: isLocal ? 0 : costForModelUsage(model, usage),
    isLocal,
  }
}

function summarizeByModel(byModel: Record<string, ModelUsage>): UsagePeriodSummary {
  const cloudModels: ModelUsageBreakdown[] = []
  const localModels: ModelUsageBreakdown[] = []
  let totalCostUsd = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0

  for (const [model, usage] of Object.entries(byModel)) {
    if (!usage.inputTokens && !usage.outputTokens) continue
    const row = toBreakdown(model, usage)
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    totalCostUsd += row.estimatedCostUsd
    if (row.isLocal) localModels.push(row)
    else cloudModels.push(row)
  }

  const byTokens = (a: ModelUsageBreakdown, b: ModelUsageBreakdown) =>
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)

  cloudModels.sort(byTokens)
  localModels.sort(byTokens)

  return { totalCostUsd, cloudModels, localModels, totalInputTokens, totalOutputTokens }
}

export function summarizeUsageByModel(byModel: Record<string, ModelUsage>): UsagePeriodSummary {
  return summarizeByModel(byModel)
}

export function buildUsageSummary(
  events: UsageEvent[],
  threads: Thread[],
  now = Date.now(),
): UsageSummary {
  const trackingStartedAt =
    events.length > 0 ? events.reduce((min, e) => Math.min(min, e.at), events[0]!.at) : null

  return {
    day: summarizeByModel(aggregateEventsByModel(events, DAY_MS, now)),
    month: summarizeByModel(aggregateEventsByModel(events, MONTH_MS, now)),
    period90d: summarizeByModel(aggregateEventsByModel(events, PERIOD_90D_MS, now)),
    allTime: summarizeByModel(aggregateThreadUsage(threads)),
    trackingStartedAt,
  }
}

export function pruneUsageEvents(events: UsageEvent[], now = Date.now()): UsageEvent[] {
  const cutoff = now - PERIOD_90D_MS
  return events.filter((e) => e.at >= cutoff)
}

/** Parse persisted ledger JSON; drops malformed entries. */
export function parseUsageEvents(raw: unknown): UsageEvent[] {
  if (!Array.isArray(raw)) return []
  const out: UsageEvent[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Partial<UsageEvent>
    if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue
    if (typeof rec.model !== 'string' || !rec.model) continue
    if (typeof rec.inputTokens !== 'number' || typeof rec.outputTokens !== 'number') continue
    if (
      rec.source !== 'agent' &&
      rec.source !== 'small-tasks' &&
      rec.source !== 'safety-classifier'
    ) {
      continue
    }
    out.push({
      at: rec.at,
      model: rec.model,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      source: rec.source,
      ...(rec.cacheReadTokens !== undefined ? { cacheReadTokens: rec.cacheReadTokens } : {}),
      ...(rec.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: rec.cacheCreationTokens }
        : {}),
      ...(typeof rec.projectId === 'string' ? { projectId: rec.projectId } : {}),
      ...(typeof rec.threadId === 'string' ? { threadId: rec.threadId } : {}),
    })
  }
  return out
}
