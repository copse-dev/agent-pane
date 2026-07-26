// Resolve the default chat model from the plan-aware intellect/cost Pareto
// frontier among routes the user can actually use today. Mirrors the Settings
// "Model value map" candidate set (minus discovery overlays), then picks the
// single best-value point via {@link pickBestValueFrontierModel}.

import {
  frontierForKnownModels,
  pickBestValueFrontierModel,
  type FrontierCandidate,
} from '@copse/llm/pareto-frontier.ts'
import {
  extraProviderFrontierCandidates,
  localFrontierCandidates,
  openRouterFrontierCandidates,
} from '@copse/llm/frontier-candidates.ts'
import { CLOUD_MODELS } from '@copse/llm/model-catalog.ts'
import { isNoTrainingModelPath, isZeroRetentionModelPath } from '@copse/llm/data-policies.ts'
import { LMSTUDIO_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { applyPlanCoverage } from '@shared/plan-inclusion.ts'
import { FALLBACK_APP_CHAT_MODEL, resolveLocalServerUrl } from '@shared/lm-studio-defaults.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import { fetchLmStudioModelsCached } from './lm-studio-models.ts'
import { fetchOpenRouterModelsCached } from './openrouter-models.ts'
import { loadPlanUsageSnapshot } from '../plan-usage-bridge.ts'
import { getSetting, isProviderAvailable } from '../storage/settings.ts'

function localServerUrl(): string {
  return resolveLocalServerUrl(getSetting<string>('localServerUrl', ''), process.env)
}

async function loadedLocalModelIds(): Promise<string[]> {
  const result = await fetchLmStudioModelsCached(localServerUrl())
  if (!result.ok) return []
  return result.models.map((m) => m.id)
}

async function openRouterPricedModels(): Promise<
  Array<{
    id: string
    name: string
    inputPricePerMTok: number | null
    outputPricePerMTok: number | null
  }>
> {
  if (!isProviderAvailable('openrouter')) return []
  const result = await fetchOpenRouterModelsCached()
  if (!result.ok) return []
  return result.models
    .filter((m) => m.supportsTools)
    .map((m) => ({
      id: m.id,
      name: m.name,
      inputPricePerMTok: m.inputPricePerMTok,
      outputPricePerMTok: m.outputPricePerMTok,
    }))
}

/** True when a candidate's route is configured and usable right now. */
function isRoutableCandidate(
  candidate: FrontierCandidate,
  availableCloud: ReadonlySet<string>,
): boolean {
  if (candidate.discovery) return false
  if (candidate.local) return true
  if (candidate.id.startsWith('openrouter:')) return isProviderAvailable('openrouter')
  const colon = candidate.id.indexOf(':')
  if (colon > 0 && !candidate.id.slice(0, colon).includes('/')) {
    const slug = candidate.id.slice(0, colon)
    return isProviderAvailable(slug)
  }
  // Bare cloud catalog ids (claude-*, gpt-*).
  return availableCloud.has(candidate.id)
}

function availableCloudModelIds(): Set<string> {
  const out = new Set<string>()
  for (const [id, , provider] of CLOUD_MODELS) {
    if (isProviderAvailable(provider)) out.add(id)
  }
  return out
}

function toRoutableModelId(candidate: FrontierCandidate): string {
  if (candidate.local && !candidate.id.startsWith(LMSTUDIO_MODEL_PREFIX)) {
    return `${LMSTUDIO_MODEL_PREFIX}${candidate.id}`
  }
  return candidate.id
}

/**
 * Compute the best plan/price Pareto model among configured providers.
 * Falls back to {@link FALLBACK_APP_CHAT_MODEL} when the frontier is empty.
 */
export async function resolveBestValueChatModel(): Promise<string> {
  // Mock LLM accepts any model id — keep the concrete local fallback so e2e /
  // agent loops don't wait on catalog/plan fetches.
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') {
    return FALLBACK_APP_CHAT_MODEL
  }

  const [localIds, openRouterModels, planUsage] = await Promise.all([
    loadedLocalModelIds(),
    openRouterPricedModels(),
    loadPlanUsageSnapshot().catch((): PlanUsageSnapshot | null => null),
  ])
  const extraProviders = getResolvedExtraProviders().filter((p) =>
    p.local ? true : isProviderAvailable(p.id),
  )
  const availableCloud = availableCloudModelIds()
  const extras: FrontierCandidate[] = [
    ...localFrontierCandidates(localIds),
    ...extraProviderFrontierCandidates(extraProviders),
    ...openRouterFrontierCandidates(openRouterModels),
  ]

  const openRouterZdrOnly = getSetting<boolean>('openRouterZdrOnly', true)
  const openRouterAllowTraining = getSetting<boolean>('openRouterAllowTraining', false)
  const routePolicy = {
    providers: extraProviders,
    openRouterZdrOnly,
    openRouterAllowTraining,
  }

  const keepRoute = (candidate: FrontierCandidate): boolean => {
    if (!isRoutableCandidate(candidate, availableCloud)) return false
    const local = candidate.local === true
    // Honor the same OpenRouter privacy defaults the picker / request path use.
    if (candidate.id.startsWith('openrouter:')) {
      if (
        openRouterZdrOnly &&
        !isZeroRetentionModelPath(candidate.id, {
          ...routePolicy,
          ...(local ? { local: true } : {}),
        })
      ) {
        return false
      }
      if (
        !openRouterAllowTraining &&
        !isNoTrainingModelPath(candidate.id, {
          ...routePolicy,
          ...(local ? { local: true } : {}),
        })
      ) {
        return false
      }
    }
    return true
  }

  const points = frontierForKnownModels(
    extras,
    (candidate) => applyPlanCoverage(candidate, planUsage),
    keepRoute,
  )
  const best = pickBestValueFrontierModel(points)
  if (!best) return FALLBACK_APP_CHAT_MODEL
  return toRoutableModelId(best)
}

/** Pure seam for tests that don't want to hit LM Studio / plan usage. */
export function resolveBestValueFromFrontier(
  extras: readonly FrontierCandidate[],
  planUsage: PlanUsageSnapshot | null,
  keepRoute?: (candidate: FrontierCandidate) => boolean,
): string | null {
  const points = frontierForKnownModels(
    extras,
    (candidate) => applyPlanCoverage(candidate, planUsage),
    keepRoute,
  )
  const best = pickBestValueFrontierModel(points)
  return best ? toRoutableModelId(best) : null
}
