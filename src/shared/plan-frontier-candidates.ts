// Subscription-backed ACP routes represented on the same intellect/cost scale
// as API, OpenRouter, extra-provider, and local frontier candidates. Shared by
// the Settings value map and the dynamic best-value model resolver so both
// surfaces make the same route-aware billing decision.

import { blendedPricePerMTok, type FrontierCandidate } from '@copse/llm/pareto-frontier.ts'
import { getModelInfo } from '@copse/llm/model-catalog.ts'
import { getIntellectScore } from '@copse/llm/model-intellect.ts'
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
export function planAcpFrontierCandidates(agents: readonly AcpAgentConfig[]): FrontierCandidate[] {
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
      const info = getModelInfo(resolved)
      if (!score || !info) continue
      candidates.push({
        id: acpModelValue(agent.id, choice.value),
        intellect: score.value,
        costPerMTok: blendedPricePerMTok(info),
        planAccess: { provider, modelId: resolved },
      })
    }
  }
  return candidates
}
