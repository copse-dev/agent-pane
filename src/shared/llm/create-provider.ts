import { AnthropicProvider } from './anthropic-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'
import { MockLLMProvider } from './mock-provider.ts'
import { DEFAULT_CLOUD_MODEL } from './model-catalog.ts'
import { OPENROUTER_BASE_URL } from './openrouter.ts'
import type { LLMProvider } from './types.ts'

interface ProviderKeys {
  anthropicApiKey?: string | null
  openAiApiKey?: string | null
}

// `model` is the user's selected model (from settings). It both picks the
// provider family (claude* → Anthropic, gpt* → OpenAI) and is passed through as
// the model id. Falls back to whichever key is present; mock only when
// COPSE_PANEL_MOCK_LLM=1 (tests / dev).
export function createProvider(model?: string, keys: ProviderKeys = {}): LLMProvider {
  if (process.env.COPSE_PANEL_MOCK_LLM === '1') {
    return new MockLLMProvider()
  }
  const m = model ?? ''
  const anthropicApiKey = keys.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY
  const openAiApiKey = keys.openAiApiKey ?? process.env.OPENAI_API_KEY
  if (m.startsWith('gpt')) {
    if (!openAiApiKey) {
      throw new Error(
        'OpenAI is not configured. Add OPENAI_API_KEY in Settings or choose a Claude or LM Studio model.',
      )
    }
    return new OpenAIProvider(m, { apiKey: openAiApiKey })
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
    return new AnthropicProvider(model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CLOUD_MODEL, {
      apiKey: anthropicApiKey,
    })
  }
  if (openAiApiKey) {
    return new OpenAIProvider(model ?? process.env.OPENAI_MODEL ?? 'gpt-4o', {
      apiKey: openAiApiKey,
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
  return new OpenAIProvider(model, { baseURL, apiKey: apiKey || 'lm-studio' })
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
export function createOpenRouterProvider(model: string, apiKey: string): LLMProvider {
  return new OpenAIProvider(model, {
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
    includeUsage: true,
    extraBody: { provider: { require_parameters: true } },
  })
}
