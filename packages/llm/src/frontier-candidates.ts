// Pure builders for intellect-vs-cost frontier candidates from local models,
// extra providers, and OpenRouter priced catalogs. Shared by the Settings value
// map and the best-value chat default resolver — keep these free of DOM / IPC.

import { blendedRate, type FrontierCandidate } from './pareto-frontier.ts'
import { getIntellectScore } from './model-intellect.ts'
import type { ExtraProvider } from './extra-providers.ts'
import { getLocalModelCapability, localBenchmarkScore } from './local-model-catalog.ts'

/** Frontier input for loaded local models: only canonical-scale scores. */
export function localFrontierCandidates(localModelIds: readonly string[]): FrontierCandidate[] {
  const out: FrontierCandidate[] = []
  for (const id of localModelIds) {
    const cap = getLocalModelCapability(id)
    if (!cap) continue
    const score = localBenchmarkScore(cap, 'aa-intelligence')
    if (!score) continue
    out.push({
      id,
      intellect: score.value,
      intellectEstimated: score.estimated === true,
      costPerMTok: 0,
      local: true,
      quant: cap.quant,
    })
  }
  return out
}

/**
 * Frontier input for extra-provider models (Hugging Face router, Mistral,
 * DeepSeek, user-added): any model with BOTH a stored per-MTok rate and a
 * resolvable intellect measurement joins at its real price.
 */
export function extraProviderFrontierCandidates(
  providers: readonly ExtraProvider[],
): FrontierCandidate[] {
  const out: FrontierCandidate[] = []
  for (const provider of providers) {
    for (const m of provider.models) {
      if (typeof m.inputPricePerMTok !== 'number') continue
      const score = getIntellectScore(m.id)
      if (!score) continue
      out.push({
        id: `${provider.id}:${m.id}`,
        intellect: score.value,
        intellectEstimated: score.estimated === true,
        costPerMTok: blendedRate(m.inputPricePerMTok, m.outputPricePerMTok ?? m.inputPricePerMTok),
      })
    }
  }
  return out
}

export interface OpenRouterPricedModel {
  id: string
  name: string
  inputPricePerMTok: number | null
  outputPricePerMTok: number | null
}

/** Configured OpenRouter routes with both catalog pricing and a sourced score. */
export function openRouterFrontierCandidates(
  models: readonly OpenRouterPricedModel[],
): FrontierCandidate[] {
  const out: FrontierCandidate[] = []
  for (const model of models) {
    const input = model.inputPricePerMTok
    const output = model.outputPricePerMTok
    if (input === null || output === null || input < 0 || output < 0) continue
    const id = `openrouter:${model.id}`
    const score = getIntellectScore(id)
    if (!score) continue
    out.push({
      id,
      intellect: score.value,
      intellectEstimated: score.estimated === true,
      costPerMTok: blendedRate(input, output),
    })
  }
  return out
}
