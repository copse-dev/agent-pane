/** The run budget spans many requests; it is not a model's per-response limit. */
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { withCredentialOutputRedaction } from '@copse/llm/credential-output-provider.ts'
import { buildGuestProvider } from './guest-provider.ts'

export function parseOutputLimit(value: string | undefined): number {
  const limit = value === undefined ? 16_384 : Number(value)
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('--max-output-tokens must be a positive safe integer')
  return limit
}

export function buildCliProvider(options: {
  model: string
  url: string
  apiKey: string | undefined
  remainingTokens: number
  outputLimit: number
  fetch: typeof globalThis.fetch
}): LLMProvider {
  return withCredentialOutputRedaction(
    buildGuestProvider(
      {
        kind: 'openai-compatible',
        model: options.model,
        apiKeySlug: 'cli',
        url: options.url,
        label: 'the --provider-url endpoint',
        local: true,
        includeUsage: true,
        apiStyle: null,
        extraBody: null,
        params: { maxOutputTokens: Math.min(options.outputLimit, options.remainingTokens) },
      },
      options.apiKey ?? null,
      options.fetch,
    ),
    options.apiKey ? [options.apiKey] : [],
  )
}
