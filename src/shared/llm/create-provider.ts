import { AnthropicProvider } from './anthropic-provider.ts'
import { OpenAIProvider } from './openai-provider.ts'
import { MockLLMProvider } from './mock-provider.ts'
import type { LLMProvider } from './types.ts'

// `model` is the user's selected model (from settings). It both picks the
// provider family (claude* → Anthropic, gpt* → OpenAI) and is passed through as
// the model id. Falls back to whichever key is present, then mock.
export function createProvider(model?: string): LLMProvider {
  if (process.env.AGENT_WINDOW_MOCK_LLM === '1') {
    return new MockLLMProvider()
  }
  const m = model ?? ''
  if (m.startsWith('gpt') && process.env.OPENAI_API_KEY) {
    return new OpenAIProvider(m)
  }
  if (m.startsWith('claude') && process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(m)
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6')
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider(model ?? process.env.OPENAI_MODEL ?? 'gpt-4o')
  }
  return new MockLLMProvider()
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
