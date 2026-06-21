import type { ThreadUsage } from '@shared/types'

// Per-million-token rates as [input, output]. Keep in sync with Anthropic /
// OpenAI public pricing.
const RATES: Record<string, [number, number]> = {
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-opus-4-8': [5.0, 25.0],
  'claude-haiku-4-5': [1.0, 5.0],
  'gpt-4o': [2.5, 10.0],
  'gpt-4o-mini': [0.15, 0.6],
}

export function isLocalModel(model: string): boolean {
  return model === 'lm-studio' || model.startsWith('lmstudio:')
}

function costForModel(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  if (isLocalModel(model)) return 0
  const rate = RATES[model]
  if (!rate) return 0
  return (usage.inputTokens / 1_000_000) * rate[0] + (usage.outputTokens / 1_000_000) * rate[1]
}

export function estimateUsageCost(
  byModel: Record<string, { inputTokens: number; outputTokens: number }>,
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
    const cost = costForModel(model, usage)
    if (cost > 0) hasBillable = true
    totalCost += cost
  }

  if (!hasBillable && hasLocal) return 'free (local)'
  if (totalCost === 0) return ''
  const costStr = totalCost < 0.01 ? '<$0.01' : `~$${totalCost.toFixed(2)}`
  return hasLocal ? `${costStr} (+ local free)` : costStr
}

/** Cost line for the footer; falls back to chat model when usage has no per-model breakdown. */
export function formatThreadUsageCost(usage: ThreadUsage, fallbackChatModel: string): string {
  if (usage.byModel && Object.keys(usage.byModel).length > 0) {
    return estimateUsageCost(usage.byModel)
  }
  if (!usage.inputTokens && !usage.outputTokens) return ''
  return estimateUsageCost({
    [fallbackChatModel]: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  })
}
