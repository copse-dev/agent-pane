import type { ThreadUsage, ModelUsage } from './wire-types.ts'
import { getModelInfo } from './model-catalog.ts'
import type { ModelPricing, ModelPricingMap } from './model-pricing.ts'

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

/** Whether a cloud model has a real rate, including an explicitly free (zero-rate) route. */
export function hasModelPricing(model: string, pricing?: ModelPricingMap): boolean {
  return pricingForModel(model, pricing) !== null
}

/** USD estimate for a single model's token usage (cache-aware when breakdown is present). */
export function costForModelUsage(
  model: string,
  usage: ModelUsage,
  pricing?: ModelPricingMap,
): number {
  const info = pricingForModel(model, pricing)
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

export function estimateUsageCost(
  byModel: Record<string, ModelUsage>,
  pricing?: ModelPricingMap,
): string {
  const entries = Object.entries(byModel).filter(([, u]) => u.inputTokens > 0 || u.outputTokens > 0)
  if (entries.length === 0) return ''

  let totalCost = 0
  let hasLocal = false
  let hasPricedCloud = false
  let hasUnpricedCloud = false

  for (const [model, usage] of entries) {
    if (isLocalModel(model)) {
      hasLocal = true
      continue
    }
    if (hasModelPricing(model, pricing)) hasPricedCloud = true
    else hasUnpricedCloud = true
    const cost = costForModelUsage(model, usage, pricing)
    totalCost += cost
  }

  if (totalCost === 0) {
    if (hasUnpricedCloud) return ''
    if (hasPricedCloud) return 'free'
    if (hasLocal) return 'free (local)'
    return ''
  }
  const costStr = totalCost < 0.01 ? '<$0.01' : `~$${totalCost.toFixed(2)}`
  if (hasUnpricedCloud) return `${costStr} (partial)`
  return hasLocal ? `${costStr} (+ local free)` : costStr
}

/** Cost line for the footer; falls back to chat model when usage has no per-model breakdown. */
export function formatThreadUsageCost(
  usage: ThreadUsage,
  fallbackChatModel: string,
  pricing?: ModelPricingMap,
): string {
  if (usage.byModel && Object.keys(usage.byModel).length > 0) {
    return estimateUsageCost(usage.byModel, pricing)
  }
  if (!usage.inputTokens && !usage.outputTokens) return ''
  return estimateUsageCost(
    {
      [fallbackChatModel]: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    },
    pricing,
  )
}
