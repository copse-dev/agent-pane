import type { ThreadUsage, ModelUsage, TokenUsage } from './wire-types.ts'
import { getModelInfo } from './model-catalog.ts'
import type { ModelPricing, ModelPricingMap } from './model-pricing.ts'
import { splitServiceTierUsage } from './model-usage.ts'
import { USAGE_SERVICE_TIERS, type UsageServiceTier } from './service-tier.ts'

export function isLocalModel(model: string): boolean {
  return model === 'lm-studio' || model.startsWith('lmstudio:')
}

/**
 * Rates for every model outside the static cloud catalog — extra providers,
 * OpenRouter, and anything else a route learns — merged into one map by the
 * caller (see model-pricing.ts). A model absent from both the catalog and this
 * map is *unpriced*, and costs nothing rather than guessing.
 */
function pricingForModel(model: string, pricing?: ModelPricingMap): ModelPricing | null {
  if (isLocalModel(model)) return null
  const info = getModelInfo(model) ?? pricing?.[model]
  if (!info) return null
  return info
}

function pricingForTier(
  model: string,
  tier: UsageServiceTier,
  pricing?: ModelPricingMap,
): { pricing: ModelPricing | null; fallback: boolean } {
  const standard = pricingForModel(model, pricing)
  if (!standard) return { pricing: null, fallback: false }
  const tierPricing = standard.serviceTierPricing?.[tier]
  // Scale rates are capacity commitments rather than a catalogued token price.
  // Every missing tier deliberately uses the standard rate and is marked for
  // the caller, never presented as an exact tier price.
  return tierPricing
    ? { pricing: tierPricing, fallback: false }
    : { pricing: standard, fallback: true }
}

/** Whether a cloud model has a real rate, including an explicitly free (zero-rate) route. */
export function hasModelPricing(model: string, pricing?: ModelPricingMap): boolean {
  return pricingForModel(model, pricing) !== null
}

/**
 * Whether a cloud model's listed rate is explicitly zero (a `:free` route, for
 * example) — priced, unlike an unlisted model, but billed at nothing.
 */
export function hasZeroModelPricing(model: string, pricing?: ModelPricingMap): boolean {
  const info = pricingForModel(model, pricing)
  if (!info) return false
  return (
    info.inputPricePerMTok === 0 &&
    info.outputPricePerMTok === 0 &&
    (info.cacheReadPricePerMTok ?? 0) === 0 &&
    (info.cacheCreationPricePerMTok ?? 0) === 0
  )
}

export interface UsageCostOptions {
  /**
   * The caller already explains local-model usage as free, so the cost line
   * leaves off its "(+ local free)" suffix instead of saying it twice.
   */
  localFreeExplained?: boolean
}

/** USD estimate for a single model's token usage (cache-aware when breakdown is present). */
function costForUsage(usage: TokenUsage, info: ModelPricing | null): number {
  if (!info) return 0

  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheCreation = usage.cacheCreationTokens ?? 0
  const hasCacheBreakdown =
    usage.cacheReadTokens !== undefined || usage.cacheCreationTokens !== undefined
  const freshInput = hasCacheBreakdown
    ? Math.max(0, usage.inputTokens - cacheRead - cacheCreation)
    : usage.inputTokens

  const inputRate = info.inputPricePerMTok
  const cacheReadRate = info.cacheReadPricePerMTok ?? inputRate
  const cacheCreationRate = info.cacheCreationPricePerMTok ?? inputRate

  return (
    (freshInput / 1_000_000) * inputRate +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheCreation / 1_000_000) * cacheCreationRate +
    (usage.outputTokens / 1_000_000) * info.outputPricePerMTok
  )
}

export interface ModelUsageCost {
  costUsd: number
  /** A non-standard tier had no complete catalog rate, so standard pricing was used. */
  tierPricingFallback: boolean
}

/**
 * Cost a model record while keeping each non-standard processing tier separate.
 * The standard-rate remainder preserves compatibility with usage saved before
 * service tiers were recorded.
 */
export function costForModelUsageWithDetails(
  model: string,
  usage: ModelUsage,
  pricing?: ModelPricingMap,
): ModelUsageCost {
  const standard = pricingForModel(model, pricing)
  const split = splitServiceTierUsage(usage)
  let costUsd = costForUsage(split.standard, standard)
  let tierPricingFallback = false
  for (const tier of USAGE_SERVICE_TIERS) {
    const tierUsage = split.tiers[tier]
    if (!tierUsage) continue
    const resolved = pricingForTier(model, tier, pricing)
    costUsd += costForUsage(tierUsage, resolved.pricing)
    tierPricingFallback ||= resolved.fallback
  }
  return { costUsd, tierPricingFallback }
}

/** USD estimate for a single model's token usage (cache-aware when breakdown is present). */
export function costForModelUsage(
  model: string,
  usage: ModelUsage,
  pricing?: ModelPricingMap,
): number {
  return costForModelUsageWithDetails(model, usage, pricing).costUsd
}

export function estimateUsageCost(
  byModel: Record<string, ModelUsage>,
  pricing?: ModelPricingMap,
  options: UsageCostOptions = {},
): string {
  const entries = Object.entries(byModel).filter(([, u]) => u.inputTokens > 0 || u.outputTokens > 0)
  if (entries.length === 0) return ''

  let totalCost = 0
  let hasLocal = false
  let hasPricedCloud = false
  let hasUnpricedCloud = false
  let hasTierPricingFallback = false

  for (const [model, usage] of entries) {
    if (isLocalModel(model)) {
      hasLocal = true
      continue
    }
    if (hasModelPricing(model, pricing)) hasPricedCloud = true
    else hasUnpricedCloud = true
    const cost = costForModelUsageWithDetails(model, usage, pricing)
    totalCost += cost.costUsd
    hasTierPricingFallback ||= cost.tierPricingFallback
  }

  if (totalCost === 0) {
    if (hasUnpricedCloud) return ''
    if (hasPricedCloud) return hasTierPricingFallback ? 'free (standard tier fallback)' : 'free'
    if (hasLocal) return 'free (local)'
    return ''
  }
  const costStr = totalCost < 0.01 ? '<$0.01' : `~$${totalCost.toFixed(2)}`
  const qualifiedCost = hasUnpricedCloud ? `${costStr} (partial)` : costStr
  const tierQualifiedCost = hasTierPricingFallback
    ? `${qualifiedCost} (standard tier fallback)`
    : qualifiedCost
  return hasLocal && !options.localFreeExplained
    ? `${tierQualifiedCost} (+ local free)`
    : tierQualifiedCost
}

/** Cost line for the footer; falls back to chat model when usage has no per-model breakdown. */
export function formatThreadUsageCost(
  usage: ThreadUsage,
  fallbackChatModel: string,
  pricing?: ModelPricingMap,
  options: UsageCostOptions = {},
): string {
  if (usage.byModel && Object.keys(usage.byModel).length > 0) {
    return estimateUsageCost(usage.byModel, pricing, options)
  }
  if (!usage.inputTokens && !usage.outputTokens) return ''
  return estimateUsageCost(
    {
      [fallbackChatModel]: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    },
    pricing,
    options,
  )
}
