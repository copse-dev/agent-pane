import { AnthropicProvider } from './anthropic-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'
import { MockLLMProvider } from './mock-provider.ts'
import { DEFAULT_CLOUD_MODEL } from './model-catalog.ts'
import { OPENROUTER_BASE_URL } from './openrouter.ts'
import type { ExtraProvider } from './extra-providers.ts'
import type { LLMProvider } from './types.ts'

interface ProviderKeys {
  anthropicApiKey?: string | null
  openAiApiKey?: string | null
}

// `model` is the user's selected model (from settings). It both picks the
// provider family (claude* → Anthropic, gpt* → OpenAI) and is passed through as
// the model id. Falls back to whichever key is present; mock only when
// COPSE_PANEL_MOCK_LLM=1 (tests / dev). `promptCacheKey` is a stable per-thread
// hint forwarded to OpenAI's `prompt_cache_key` to raise cache hit rates (#584).
export function createProvider(
  model?: string,
  keys: ProviderKeys = {},
  promptCacheKey?: string,
): LLMProvider {
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') {
    return new MockLLMProvider()
  }
  const m = model ?? ''
  const cacheKeyOpt = promptCacheKey ? { promptCacheKey } : {}
  const anthropicApiKey = keys.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY']
  const openAiApiKey = keys.openAiApiKey ?? process.env['OPENAI_API_KEY']
  if (m.startsWith('gpt')) {
    if (!openAiApiKey) {
      throw new Error(
        'OpenAI is not configured. Add OPENAI_API_KEY in Settings or choose a Claude or LM Studio model.',
      )
    }
    return new OpenAIProvider(m, { apiKey: openAiApiKey, ...cacheKeyOpt })
  }
  if (m.startsWith('claude')) {
    if (!anthropicApiKey) {
      throw new Error(
        'Anthropic is not configured. Add ANTHROPIC_API_KEY in Settings or choose an OpenAI or LM Studio model.',
      )
    }
    return new AnthropicProvider(m, { apiKey: anthropicApiKey })
  }
  if (anthropicApiKey) {
    return new AnthropicProvider(model ?? process.env['ANTHROPIC_MODEL'] ?? DEFAULT_CLOUD_MODEL, {
      apiKey: anthropicApiKey,
    })
  }
  if (openAiApiKey) {
    return new OpenAIProvider(model ?? process.env['OPENAI_MODEL'] ?? 'gpt-4o', {
      apiKey: openAiApiKey,
      ...cacheKeyOpt,
    })
  }
  throw new Error(
    'No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings, pick an LM Studio model, or set COPSE_PANEL_MOCK_LLM=1 for development.',
  )
}

// OpenAI-compatible local servers speak the same chat API, so we reuse
// OpenAIProvider with a custom base URL. apiKey is whatever the local server
// expects (many require any non-empty value, even when auth is disabled).
export function createLocalOpenAIProvider(
  baseURL: string,
  model: string,
  apiKey = 'lm-studio',
): LLMProvider {
  // LM Studio and other OpenAI-compatible local servers need stream_options.include_usage
  // or they never report prompt/completion tokens — without that, usage chunks (and the
  // Settings usage ledger) stay empty for local models such as qwen.
  return new OpenAIProvider(model, { baseURL, apiKey: apiKey || 'lm-studio', includeUsage: true })
}

export const createLMStudioProvider = createLocalOpenAIProvider

// OpenRouter is an OpenAI-compatible cloud aggregator, so it reuses OpenAIProvider
// with OpenRouter's base URL. Unlike a local server it is billed and reports usage,
// so we keep `include_usage` on (includeUsage defaults to false when a baseURL is
// set). `model` is the upstream id with the `openrouter:` prefix already stripped.
//
// `provider: { require_parameters: true }` restricts OpenRouter's routing to
// upstream endpoints that support every parameter we send — crucially `tools`.
// Without it a model id can be load-balanced onto an endpoint that ignores
// function calling, so the model narrates instead of emitting tool calls.
export function createOpenRouterProvider(
  model: string,
  apiKey: string,
  promptCacheKey?: string,
): LLMProvider {
  return new OpenAIProvider(model, {
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
    includeUsage: true,
    extraBody: { provider: { require_parameters: true } },
    ...(promptCacheKey ? { promptCacheKey } : {}),
  })
}

// An extra provider (built-in preset or user-added custom) is OpenAI-compatible,
// so it reuses OpenAIProvider with the provider's base URL. `model` is the
// upstream id with the provider slug already stripped. `includeUsage` defaults
// on for billed cloud APIs and off for a localhost server (which rarely reports
// usage); `extraBody` carries any provider-specific request fields (e.g. an
// OpenRouter-style routing hint a user pastes into the advanced field).
export function createExtraCloudProvider(
  provider: ExtraProvider,
  model: string,
  apiKey: string,
): LLMProvider {
  return new OpenAIProvider(model, {
    baseURL: provider.baseUrl,
    // Local servers usually run without auth but still want a non-empty key
    // (many reject a blank Authorization header), mirroring createLocalOpenAIProvider.
    apiKey: provider.local ? apiKey || 'lm-studio' : apiKey,
    includeUsage: provider.includeUsage ?? !provider.local,
    ...(provider.extraBody ? { extraBody: provider.extraBody } : {}),
  })
}
