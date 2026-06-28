import type { ThreadUsage, ModelUsage } from '@shared/types'
import { getModelInfo } from './model-catalog.ts'
import type { ExtraProviderPricing } from './extra-providers.ts'

export function isLocalModel(model: string): boolean {
  return model === 'lm-studio' || model.startsWith('lmstudio:')
}

/** `model selection → pricing` for extra-provider models absent from the cloud catalog. */
export type ExtraPricing = Record<string, ExtraProviderPricing>

type PricingInfo = {
  inputPricePerMTok: number
  outputPricePerMTok: number
  cacheReadPricePerMTok?: number
  cacheCreationPricePerMTok?: number
}

function pricingForModel(model: string, extra?: ExtraPricing): PricingInfo | null {
  if (isLocalModel(model)) return null
  const info = getModelInfo(model) ?? extra?.[model]
  if (!info) return null
  return info
}

/** USD estimate for a single model's token usage (cache-aware when breakdown is present). */
export function costForModelUsage(model: string, usage: ModelUsage, extra?: ExtraPricing): number {
  const info = pricingForModel(model, extra)
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
  extra?: ExtraPricing,
): string {
  const entries = Object.entries(byModel).filter(([, u]) => u.inputTokens > 0 || u.outputTokens > 0)
  if (entries.length === 0) return ''

  let totalCost = 0
  let hasLocal = false
  let hasBillable = false

  for (const [model, usage] of entries) {
    if (isLocalModel(model)) {
      hasLocal = true
      continue
    }
    const cost = costForModelUsage(model, usage, extra)
    if (cost > 0) hasBillable = true
    totalCost += cost
  }

  if (!hasBillable && hasLocal) return 'free (local)'
  if (totalCost === 0) return ''
  const costStr = totalCost < 0.01 ? '<$0.01' : `~$${totalCost.toFixed(2)}`
  return hasLocal ? `${costStr} (+ local free)` : costStr
}

/** Cost line for the footer; falls back to chat model when usage has no per-model breakdown. */
export function formatThreadUsageCost(
  usage: ThreadUsage,
  fallbackChatModel: string,
  extra?: ExtraPricing,
): string {
  if (usage.byModel && Object.keys(usage.byModel).length > 0) {
    return estimateUsageCost(usage.byModel, extra)
  }
  if (!usage.inputTokens && !usage.outputTokens) return ''
  return estimateUsageCost(
    {
      [fallbackChatModel]: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    },
    extra,
  )
}
