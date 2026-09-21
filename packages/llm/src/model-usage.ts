import type { ModelUsage, TokenUsage } from './wire-types.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import { USAGE_SERVICE_TIERS, type UsageServiceTier } from './service-tier.ts'

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function tokenUsageOrNull(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const usage = value
  if (typeof usage['inputTokens'] !== 'number' || typeof usage['outputTokens'] !== 'number') {
    return null
  }
  if (!Number.isFinite(usage['inputTokens']) || !Number.isFinite(usage['outputTokens'])) return null
  const cacheReadTokens = usage['cacheReadTokens']
  const cacheCreationTokens = usage['cacheCreationTokens']
  if (
    cacheReadTokens !== undefined &&
    (typeof cacheReadTokens !== 'number' || !Number.isFinite(cacheReadTokens))
  ) {
    return null
  }
  if (
    cacheCreationTokens !== undefined &&
    (typeof cacheCreationTokens !== 'number' || !Number.isFinite(cacheCreationTokens))
  ) {
    return null
  }
  return {
    inputTokens: usage['inputTokens'],
    outputTokens: usage['outputTokens'],
    ...(typeof cacheReadTokens === 'number' ? { cacheReadTokens } : {}),
    ...(typeof cacheCreationTokens === 'number' ? { cacheCreationTokens } : {}),
  }
}

function cappedTierUsage(requested: TokenUsage, remaining: TokenUsage): TokenUsage {
  const inputTokens = Math.min(nonNegative(requested.inputTokens), remaining.inputTokens)
  const outputTokens = Math.min(nonNegative(requested.outputTokens), remaining.outputTokens)
  const availableCachedInput = inputTokens
  const cacheReadTokens = Math.min(
    nonNegative(requested.cacheReadTokens),
    remaining.cacheReadTokens ?? 0,
    availableCachedInput,
  )
  const cacheCreationTokens = Math.min(
    nonNegative(requested.cacheCreationTokens),
    remaining.cacheCreationTokens ?? 0,
    availableCachedInput - cacheReadTokens,
  )
  return {
    inputTokens,
    outputTokens,
    ...(requested.cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(requested.cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  }
}

function remainingAfter(remaining: TokenUsage, used: TokenUsage): TokenUsage {
  const inputTokens = remaining.inputTokens - used.inputTokens
  const outputTokens = remaining.outputTokens - used.outputTokens
  const cacheReadTokens = Math.min(
    remaining.cacheReadTokens === undefined
      ? 0
      : Math.max(0, remaining.cacheReadTokens - (used.cacheReadTokens ?? 0)),
    inputTokens,
  )
  const cacheCreationTokens = Math.min(
    remaining.cacheCreationTokens === undefined
      ? 0
      : Math.max(0, remaining.cacheCreationTokens - (used.cacheCreationTokens ?? 0)),
    inputTokens - cacheReadTokens,
  )
  return {
    inputTokens,
    outputTokens,
    ...(remaining.cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(remaining.cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  }
}

function addTokens(prev: TokenUsage, delta: TokenUsage): TokenUsage {
  const next: TokenUsage = {
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

/** Add two usage records without losing their individual non-standard-tier buckets. */
export function mergeModelUsage(prev: ModelUsage, delta: ModelUsage): ModelUsage {
  const next: ModelUsage = addTokens(prev, delta)
  const tiers = USAGE_SERVICE_TIERS.filter(
    (tier) =>
      prev.serviceTierUsage?.[tier] !== undefined || delta.serviceTierUsage?.[tier] !== undefined,
  )
  if (tiers.length > 0) {
    const serviceTierUsage: Partial<Record<UsageServiceTier, TokenUsage>> = {}
    for (const tier of tiers) {
      const before = prev.serviceTierUsage?.[tier]
      const addition = delta.serviceTierUsage?.[tier]
      if (before && addition) serviceTierUsage[tier] = addTokens(before, addition)
      else if (before) serviceTierUsage[tier] = before
      else if (addition) serviceTierUsage[tier] = addition
    }
    next.serviceTierUsage = serviceTierUsage
  }
  return next
}

/** Mark one complete usage record as having been served at a non-standard tier. */
export function usageAtServiceTier(
  usage: TokenUsage,
  tier: UsageServiceTier | undefined,
): ModelUsage {
  const base: ModelUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
  }
  if (tier !== undefined) {
    base.serviceTierUsage = {
      [tier]: {
        inputTokens: base.inputTokens,
        outputTokens: base.outputTokens,
        ...(base.cacheReadTokens !== undefined ? { cacheReadTokens: base.cacheReadTokens } : {}),
        ...(base.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: base.cacheCreationTokens }
          : {}),
      },
    }
  }
  return base
}

/** The portion of a usage record that was billed at standard processing rates. */
export function standardTierUsage(usage: ModelUsage): TokenUsage {
  return splitServiceTierUsage(usage).standard
}

/**
 * Split total usage into non-overlapping tier buckets. Persisted thread metadata
 * is user-writable JSON, so each bucket is capped to the recorded total instead
 * of letting stale or malformed data double-count a cost estimate.
 */
export function splitServiceTierUsage(usage: ModelUsage): {
  standard: TokenUsage
  tiers: Partial<Record<UsageServiceTier, TokenUsage>>
} {
  let remaining: TokenUsage = {
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    ...(usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: nonNegative(usage.cacheReadTokens) }
      : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: nonNegative(usage.cacheCreationTokens) }
      : {}),
  }
  const tiers: Partial<Record<UsageServiceTier, TokenUsage>> = {}
  for (const tier of USAGE_SERVICE_TIERS) {
    const bucket = tokenUsageOrNull(usage.serviceTierUsage?.[tier])
    if (!bucket) continue
    const capped = cappedTierUsage(bucket, remaining)
    tiers[tier] = capped
    remaining = remainingAfter(remaining, capped)
  }
  return { standard: remaining, tiers }
}
