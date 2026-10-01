import type { PlanUsageSnapshot } from '@copse/plan-usage'
import type { ExtraProvider } from '@copse/llm/extra-providers.ts'
import { extraProviderSlugFromModel } from '@copse/llm/extra-providers.ts'
import { resolveAgentModelIdentity } from '@copse/llm/agent-model-identity.ts'
import { acpModelVersionName, acpPlanProvider, parseAcpModelSelection } from '@shared/acp.ts'
import { canonicalAcpAgentId } from '@shared/acp-known-agents.ts'
import { resolvePlanInclusion } from '@shared/plan-inclusion.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'

export type ModelCoverage = 'local' | 'plan' | 'paid'

interface CoverageContext {
  agents: readonly AcpAgentConfig[]
  extraProviders: readonly ExtraProvider[]
  planUsage: PlanUsageSnapshot | null
}

/** Classify the selected route, never another route to the same model. */
export function modelCoverage(value: string, context: CoverageContext): ModelCoverage | undefined {
  // Automatic selectors and placeholder rows have no concrete billing route.
  if (!value || value.startsWith('auto:')) return undefined
  if (value.startsWith('lmstudio:')) return 'local'
  const providerId = extraProviderSlugFromModel(value)
  if (context.extraProviders.some((provider) => provider.id === providerId && provider.local)) {
    return 'local'
  }

  const selection = parseAcpModelSelection(value)
  if (!selection || !context.planUsage) return 'paid'
  const agent = context.agents.find(
    (candidate) =>
      candidate.enabled && canonicalAcpAgentId(candidate.id) === canonicalAcpAgentId(selection.id),
  )
  if (!agent) return 'paid'
  const provider = acpPlanProvider(agent)
  if (!provider) return 'paid'
  // A configured API-key/base-URL override is not the account whose plan we probed.
  const authOverrides =
    provider === 'claude'
      ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
      : ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']
  if (authOverrides.some((key) => agent.env?.[key]?.trim())) return 'paid'
  const model = selection.model ?? agent.model
  const choice = agent.availableModels?.find((candidate) => candidate.value === model)
  const identity = resolveAgentModelIdentity(
    model,
    acpModelVersionName(choice?.description),
    choice?.label,
  )
  const inclusion = resolvePlanInclusion(provider, identity ?? model, context.planUsage)
  return inclusion && !inclusion.exhausted ? 'plan' : 'paid'
}
