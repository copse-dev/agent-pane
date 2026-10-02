// Subscription-backed ACP routes represented on the same intellect/cost scale
// as API, OpenRouter, extra-provider, and local frontier candidates. Shared by
// the Settings value map and the dynamic best-value model resolver so both
// surfaces make the same route-aware billing decision.

import { blendedPricePerMTok, type FrontierCandidate } from '@copse/llm/pareto-frontier.ts'
import { getModelInfo, MODEL_CATALOG } from '@copse/llm/model-catalog.ts'
import { getIntellectScore, resolveIntellectModelId } from '@copse/llm/model-intellect.ts'
import { resolveAgentModelIdentity } from '@copse/llm/agent-model-identity.ts'
import { acpModelChoiceLabel, acpModelValue, acpModelVersionName, acpPlanProvider } from './acp.ts'
import type { AcpAgentConfig, AcpModelChoice } from './types/acp.ts'

/**
 * Models advertised by known subscription-backed ACP agents. Each resolvable
 * model is included, rather than only the agent's strongest one, so identity
 * grouping can replace every paid duplicate with the exact plan route.
 *
 * `planAccess` describes the possible billing path without claiming it is
 * currently free. `applyPlanCoverage` checks the live usage snapshot and only
 * sets `plan` while the relevant window has headroom.
 */
export function planAcpFrontierCandidates(
  agents: readonly AcpAgentConfig[],
  pricedRoutes: readonly FrontierCandidate[] = [],
): FrontierCandidate[] {
  // Newly advertised models can have a sourced score and a live provider price
  // before our bundled catalog catches up. Reuse only exact model identities;
  // a sibling model's price says nothing about this model's plan consumption.
  const livePrices = new Map<string, number>()
  for (const route of pricedRoutes) {
    if (route.local || route.plan !== undefined || route.planAccess !== undefined) continue
    if (!Number.isFinite(route.costPerMTok) || route.costPerMTok < 0) continue
    const identity = resolveIntellectModelId(route.id)
    if (!identity) continue
    const previous = livePrices.get(identity)
    if (previous === undefined || route.costPerMTok < previous) {
      livePrices.set(identity, route.costPerMTok)
    }
  }
  const candidates: FrontierCandidate[] = []
  for (const agent of agents) {
    if (!agent.enabled) continue
    const provider = acpPlanProvider(agent)
    if (!provider) continue
    const advertised = agent.availableModels ?? []
    const selected = agent.model
    const selectedChoice = selected
      ? advertised.find((choice) => choice.value === selected)
      : undefined
    const choices = new Map<string, AcpModelChoice>()
    if (selected) choices.set(selected, selectedChoice ?? { value: selected, label: selected })
    for (const choice of advertised) choices.set(choice.value, choice)

    for (const choice of choices.values()) {
      // Use the same identity forms as the picker, including descriptions that
      // carry a concrete version behind labels such as "Default".
      const resolved = resolveAgentModelIdentity(
        choice.value,
        acpModelVersionName(choice.description),
        choice.label,
        acpModelChoiceLabel(choice),
      )
      if (!resolved) continue
      const score = getIntellectScore(resolved)
      // Benchmark ids can differ from API ids (gpt-6-1-sol vs gpt-6.1-sol).
      // Match bundled prices by the same identity before consulting live prices.
      const info =
        getModelInfo(resolved) ??
        Object.entries(MODEL_CATALOG).find(([id]) => resolveIntellectModelId(id) === resolved)?.[1]
      const price = info ? blendedPricePerMTok(info) : livePrices.get(resolved)
      if (!score || price === undefined) continue
      candidates.push({
        id: acpModelValue(agent.id, choice.value),
        intellect: score.value,
        costPerMTok: price,
        planAccess: { provider, modelId: resolved },
      })
    }
  }
  return candidates
}
