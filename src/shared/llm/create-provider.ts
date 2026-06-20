import { AnthropicProvider } from './anthropic-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'
import { MockLLMProvider } from './mock-provider.ts'
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
  if (m.startsWith('gpt') && openAiApiKey) {
    return new OpenAIProvider(m, { apiKey: openAiApiKey })
  }
  if (m.startsWith('claude') && anthropicApiKey) {
    return new AnthropicProvider(m, { apiKey: anthropicApiKey })
  }
  if (anthropicApiKey) {
    return new AnthropicProvider(model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6', {
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

// LM Studio (and other OpenAI-compatible local servers) speak the OpenAI API,
// so we reuse OpenAIProvider with a custom base URL. apiKey is whatever the
// local server expects (LM Studio may require one if auth is enabled).
export function createLMStudioProvider(
  baseURL: string,
  model: string,
  apiKey = 'lm-studio',
): LLMProvider {
  return new OpenAIProvider(model, { baseURL, apiKey: apiKey || 'lm-studio' })
}
