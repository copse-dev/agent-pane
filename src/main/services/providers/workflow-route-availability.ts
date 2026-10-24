import { parseChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import { CLOUD_MODELS } from '@copse/llm/model-catalog.ts'
import { getChatGptPlanService } from './chatgpt-plan-service.ts'
import { assertModelMakerAllowed } from './model-maker-policy.ts'
import { apiKeyForDescription, describeProvider } from './provider-selection.ts'
import { providerKeyStatus } from './provider-key-status.ts'
import { isOpenAiModelAvailable } from './openai-model-availability.ts'
import { fetchLmStudioModelsCached } from './lm-studio-models.ts'
import { fetchOpenRouterModelsCached } from './openrouter-models.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import { fetchOpenAiCompatibleModels } from './provider-models.ts'
import { hostRoutedNamespace } from '@copse/llm/model-selection.ts'

/** Availability is a preflight snapshot, never a guarantee that a later inference succeeds. */
export async function assertWorkflowRouteAvailable(model: string): Promise<void> {
  assertModelMakerAllowed(model)
  if (hostRoutedNamespace(model)) throw new Error(`${model} is not a callable workflow route.`)
  // Mock mode cannot spend; still preserve the maker and callable-route guards.
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') return
  if (model.startsWith('openrouter:') && model.endsWith(':batch'))
    throw new Error('Batch-only models cannot run workflow workers.')
  const plan = parseChatGptPlanModel(model)
  if (plan) {
    const service = getChatGptPlanService()
    const account = service.status().accounts.find((entry) => entry.clientId === plan.clientId)
    if (!account?.connected || !account.planEnabled)
      throw new Error('ChatGPT plan connection is unavailable.')
    const catalog = await service.models(plan.clientId)
    if (!catalog.models.some((entry) => entry.slug === plan.model))
      throw new Error(`ChatGPT does not advertise ${plan.model}.`)
    return
  }
  const description = await describeProvider(model)
  if (description.kind === 'lm-studio') {
    const catalog = await fetchLmStudioModelsCached(description.url)
    if (
      !catalog.ok ||
      !catalog.models.some((entry) => entry.id === description.model && entry.embedding !== true)
    ) {
      throw new Error(`Local chat model ${description.model} is unavailable.`)
    }
    return
  }
  if (description.kind === 'openai-compatible') {
    const provider = getResolvedExtraProviders().find(
      (entry) => entry.id === description.apiKeySlug,
    )
    if (!provider?.models.some((entry) => entry.id === description.model))
      throw new Error(`${model} is not in its configured provider shortlist.`)
    const catalog = await fetchOpenAiCompatibleModels(
      description.url,
      apiKeyForDescription(description) ?? undefined,
    )
    if (!catalog.ok || !catalog.models.some((entry) => entry.id === description.model))
      throw new Error(`Provider route ${model} is unavailable.`)
    return
  }
  // A network/server failure while validating is not evidence the key went bad.
  const keyStatus = await providerKeyStatus(description.apiKeySlug)
  if (keyStatus === 'missing') throw new Error(`No validated key for ${description.apiKeySlug}.`)
  if (keyStatus === 'invalid')
    throw new Error(`${description.apiKeySlug} rejected its configured key.`)
  if (description.kind === 'openai') {
    const key = apiKeyForDescription(description)
    if (!key || !(await isOpenAiModelAvailable(key, description.model)))
      throw new Error(`OpenAI does not advertise ${description.model}.`)
  } else if (description.kind === 'anthropic') {
    if (!CLOUD_MODELS.some(([id, , provider]) => id === model && provider === 'anthropic'))
      throw new Error(`${model} is not a known Anthropic route.`)
  } else {
    const catalog = await fetchOpenRouterModelsCached()
    if (
      !catalog.ok ||
      !catalog.models.some((entry) => entry.id === description.model && entry.supportsTools)
    )
      throw new Error(`OpenRouter chat/tool route ${description.model} is unavailable.`)
  }
}
