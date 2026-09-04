import { OPENROUTER_BASE_URL, isOpenRouterModel, openRouterModelId } from '@copse/llm/openrouter.ts'
import { extraProviderForModel, extraProviderModelId } from '@copse/llm/extra-providers.ts'
import { LM_STUDIO_MODEL_IDS, resolveLocalServerUrl } from '@shared/lm-studio-defaults.ts'
import { getLmStudioApiKey, getSetting, resolveApiKey } from '../storage/settings.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'

/**
 * How a container run reaches the model for a given product model id
 * (`docs/plans/thread-in-container.md`). The guest has no network; the host
 * brokers exactly one origin for the model, so this must name it up front.
 *
 * Two shapes, because the guest speaks two dialects:
 * - `openai-compatible`: the guest's OpenAI-compatible client talks to `url`
 *   (LM Studio and other local servers, OpenAI, OpenRouter, extra providers).
 * - `product`: the guest resolves the provider itself from the model id and
 *   one API key, the way the desktop does — needed for Anthropic, whose SDK is
 *   not OpenAI-compatible.
 *
 * `apiKey` is returned to the caller, which hands it to the run through an
 * environment variable and never writes it anywhere.
 */
export type ContainerProviderPlan =
  | {
      mode: 'openai-compatible'
      /** The model id the endpoint expects (prefix stripped). */
      model: string
      url: string
      apiKey: string | null
      egress: string
    }
  | {
      mode: 'product'
      model: string
      apiKeySlug: string
      apiKey: string
      egress: string
    }

function originOf(url: string): string {
  const parsed = new URL(url)
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return `${parsed.hostname}:${String(port)}`
}

export function resolveContainerProvider(model: string): ContainerProviderPlan {
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = resolveLocalServerUrl(getSetting<string>('localServerUrl', ''), process.env)
    const configured = model.startsWith('lmstudio:') ? model.slice('lmstudio:'.length) : ''
    const id = configured || LM_STUDIO_MODEL_IDS.chat
    return {
      mode: 'openai-compatible',
      model: id,
      url,
      apiKey: getLmStudioApiKey() || null,
      egress: originOf(url),
    }
  }
  if (isOpenRouterModel(model)) {
    const apiKey = resolveApiKey('openrouter')
    if (!apiKey) throw new Error('OpenRouter is not configured; add an API key in Settings.')
    return {
      mode: 'openai-compatible',
      model: openRouterModelId(model),
      url: OPENROUTER_BASE_URL,
      apiKey,
      egress: originOf(OPENROUTER_BASE_URL),
    }
  }
  const extra = extraProviderForModel(getResolvedExtraProviders(), model)
  if (extra) {
    const apiKey = resolveApiKey(extra.id)
    if (!apiKey && !extra.local) {
      throw new Error(`${extra.label} is not configured; add an API key in Settings.`)
    }
    return {
      mode: 'openai-compatible',
      model: extraProviderModelId(model),
      url: extra.baseUrl,
      apiKey,
      egress: originOf(extra.baseUrl),
    }
  }
  if (model.startsWith('claude')) {
    const apiKey = resolveApiKey('anthropic')
    if (!apiKey) throw new Error('Anthropic is not configured; add an API key in Settings.')
    return {
      mode: 'product',
      model,
      apiKeySlug: 'anthropic',
      apiKey,
      egress: 'api.anthropic.com:443',
    }
  }
  if (model.startsWith('gpt')) {
    const apiKey = resolveApiKey('openai')
    if (!apiKey) throw new Error('OpenAI is not configured; add an API key in Settings.')
    const url = 'https://api.openai.com/v1'
    return { mode: 'openai-compatible', model, url, apiKey, egress: originOf(url) }
  }
  throw new Error(`Container runs cannot resolve a provider for model "${model}"`)
}
