import type { ModelUsage, Thread } from '@shared/types'
import type { TokenUsage } from '@copse/llm/wire-types.ts'
import {
  isLocalModel,
  costForModelUsageWithDetails,
  hasModelPricing,
} from '@copse/llm/estimate-cost.ts'
import type { ModelPricingMap } from '@copse/llm/model-pricing.ts'
import type { UsageEvent } from './usage-event.ts'
import { isRecord } from '@shared/unknown-value.ts'
import {
  isServiceTier,
  USAGE_SERVICE_TIERS,
  usageServiceTierForCall,
  type UsageServiceTier,
} from '@copse/llm/service-tier.ts'
import { mergeModelUsage, usageAtServiceTier } from '@copse/llm/model-usage.ts'

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
  /** True for catalogued routes, including routes whose published rate is zero. */
  pricingKnown: boolean
  /** A used non-standard tier has no complete catalog rate; shown at standard price. */
  tierPricingFallback?: boolean
  /** Some contributing events used estimated (not agent-reported) token counts. */
  estimatedTokens?: boolean
}

export interface UsagePeriodSummary {
  totalCostUsd: number
  cloudModels: ModelUsageBreakdown[]
  localModels: ModelUsageBreakdown[]
  totalInputTokens: number
  totalOutputTokens: number
  /** At least one cloud model in this period has usage but no known rate. */
  hasUnpricedCloudUsage: boolean
}

export interface UsageSummary {
  day: UsagePeriodSummary
  month: UsagePeriodSummary
  period90d: UsagePeriodSummary
  allTime: UsagePeriodSummary
  /** Earliest recorded event timestamp, or null when the ledger is empty. */
  trackingStartedAt: number | null
  /** Count of events in the ledger (max 90 days retained). */
  ledgerEventCount: number
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
    const usage =
      event.serviceTierUsage !== undefined
        ? event
        : usageAtServiceTier(
            event,
            usageServiceTierForCall(event.requestedServiceTier, event.responseServiceTier),
          )
    byModel = mergeUsageByModel(byModel, event.model, usage)
  }
  return byModel
}

/** Models with at least one estimated (not agent-reported) event in the window. */
function estimatedModelsSince(events: UsageEvent[], sinceMs: number, now: number): Set<string> {
  const cutoff = now - sinceMs
  const models = new Set<string>()
  for (const event of events) {
    if (event.at >= cutoff && event.estimated) models.add(event.model)
  }
  return models
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

function toBreakdown(
  model: string,
  usage: ModelUsage,
  pricing?: ModelPricingMap,
  estimatedTokens = false,
): ModelUsageBreakdown {
  const isLocal = isLocalModel(model)
  const pricingKnown = isLocal || hasModelPricing(model, pricing)
  const cost = isLocal
    ? { costUsd: 0, tierPricingFallback: false }
    : costForModelUsageWithDetails(model, usage, pricing)
  return {
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    estimatedCostUsd: cost.costUsd,
    isLocal,
    pricingKnown,
    ...(!isLocal && cost.tierPricingFallback ? { tierPricingFallback: true } : {}),
    ...(estimatedTokens ? { estimatedTokens: true } : {}),
  }
}

function summarizeByModel(
  byModel: Record<string, ModelUsage>,
  pricing?: ModelPricingMap,
  estimatedModels?: ReadonlySet<string>,
): UsagePeriodSummary {
  const cloudModels: ModelUsageBreakdown[] = []
  const localModels: ModelUsageBreakdown[] = []
  let totalCostUsd = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let hasUnpricedCloudUsage = false

  for (const [model, usage] of Object.entries(byModel)) {
    if (!usage.inputTokens && !usage.outputTokens) continue
    const row = toBreakdown(model, usage, pricing, estimatedModels?.has(model) ?? false)
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    totalCostUsd += row.estimatedCostUsd
    if (!row.isLocal && !row.pricingKnown) hasUnpricedCloudUsage = true
    if (row.isLocal) localModels.push(row)
    else cloudModels.push(row)
  }

  const byTokens = (a: ModelUsageBreakdown, b: ModelUsageBreakdown): number =>
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)

  cloudModels.sort(byTokens)
  localModels.sort(byTokens)

  return {
    totalCostUsd,
    cloudModels,
    localModels,
    totalInputTokens,
    totalOutputTokens,
    hasUnpricedCloudUsage,
  }
}

export function buildUsageSummary(
  events: UsageEvent[],
  threads: Thread[],
  now = Date.now(),
  pricing?: ModelPricingMap,
): UsageSummary {
  const trackingStartedAt =
    events.length > 0 ? events.reduce((min, e) => Math.min(min, e.at), Infinity) : null

  return {
    day: summarizeByModel(
      aggregateEventsByModel(events, DAY_MS, now),
      pricing,
      estimatedModelsSince(events, DAY_MS, now),
    ),
    month: summarizeByModel(
      aggregateEventsByModel(events, MONTH_MS, now),
      pricing,
      estimatedModelsSince(events, MONTH_MS, now),
    ),
    period90d: summarizeByModel(
      aggregateEventsByModel(events, PERIOD_90D_MS, now),
      pricing,
      estimatedModelsSince(events, PERIOD_90D_MS, now),
    ),
    // All-time is derived from saved thread usage, which carries no estimated flag.
    allTime: summarizeByModel(aggregateThreadUsage(threads), pricing),
    trackingStartedAt,
    ledgerEventCount: events.length,
  }
}

export function pruneUsageEvents(events: UsageEvent[], now = Date.now()): UsageEvent[] {
  const cutoff = now - PERIOD_90D_MS
  return events.filter((e) => e.at >= cutoff)
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const inputTokens = value['inputTokens']
  const outputTokens = value['outputTokens']
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0)
    return null
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0)
    return null
  const cacheReadTokens = value['cacheReadTokens']
  const cacheCreationTokens = value['cacheCreationTokens']
  if (
    cacheReadTokens !== undefined &&
    (typeof cacheReadTokens !== 'number' ||
      !Number.isFinite(cacheReadTokens) ||
      cacheReadTokens < 0)
  ) {
    return null
  }
  if (
    cacheCreationTokens !== undefined &&
    (typeof cacheCreationTokens !== 'number' ||
      !Number.isFinite(cacheCreationTokens) ||
      cacheCreationTokens < 0)
  ) {
    return null
  }
  return {
    inputTokens,
    outputTokens,
    ...(typeof cacheReadTokens === 'number' ? { cacheReadTokens } : {}),
    ...(typeof cacheCreationTokens === 'number' ? { cacheCreationTokens } : {}),
  }
}

function parseServiceTierUsage(
  value: unknown,
): Partial<Record<UsageServiceTier, TokenUsage>> | undefined {
  if (!isRecord(value)) return undefined
  const serviceTierUsage: Partial<Record<UsageServiceTier, TokenUsage>> = {}
  for (const tier of USAGE_SERVICE_TIERS) {
    const usage = parseTokenUsage(value[tier])
    if (usage) serviceTierUsage[tier] = usage
  }
  return Object.keys(serviceTierUsage).length > 0 ? serviceTierUsage : undefined
}

/** Parse persisted ledger JSON; drops malformed entries. */
export function parseUsageEvents(raw: unknown): UsageEvent[] {
  if (!Array.isArray(raw)) return []
  const out: UsageEvent[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const rec = item
    if (typeof rec['at'] !== 'number' || !Number.isFinite(rec['at'])) continue
    if (typeof rec['model'] !== 'string' || !rec['model']) continue
    if (typeof rec['inputTokens'] !== 'number' || typeof rec['outputTokens'] !== 'number') continue
    if (
      rec['source'] !== 'agent' &&
      rec['source'] !== 'small-tasks' &&
      rec['source'] !== 'safety-classifier' &&
      rec['source'] !== 'advisor'
    ) {
      continue
    }
    const serviceTierUsage = parseServiceTierUsage(rec['serviceTierUsage'])
    out.push({
      at: rec['at'],
      model: rec['model'],
      inputTokens: rec['inputTokens'],
      outputTokens: rec['outputTokens'],
      source: rec['source'],
      ...(typeof rec['cacheReadTokens'] === 'number'
        ? { cacheReadTokens: rec['cacheReadTokens'] }
        : {}),
      ...(typeof rec['cacheCreationTokens'] === 'number'
        ? { cacheCreationTokens: rec['cacheCreationTokens'] }
        : {}),
      ...(typeof rec['projectId'] === 'string' ? { projectId: rec['projectId'] } : {}),
      ...(typeof rec['threadId'] === 'string' ? { threadId: rec['threadId'] } : {}),
      ...(rec['estimated'] === true ? { estimated: true } : {}),
      ...(typeof rec['requestedServiceTier'] === 'string' &&
      isServiceTier(rec['requestedServiceTier'])
        ? { requestedServiceTier: rec['requestedServiceTier'] }
        : {}),
      ...(typeof rec['responseServiceTier'] === 'string' &&
      isServiceTier(rec['responseServiceTier'])
        ? { responseServiceTier: rec['responseServiceTier'] }
        : {}),
      ...(serviceTierUsage !== undefined ? { serviceTierUsage } : {}),
    })
  }
  return out
}
