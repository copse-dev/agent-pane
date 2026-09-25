// A review is not interactive, so when a provider's own retry budget runs out
// on a retryable failure (an upstream rate limit, an overloaded or unreachable
// endpoint) it is worth waiting minutes rather than failing the reviewer.
// Many reviews started together — every ready pull request, a batch re-run —
// exhausted OpenRouter's ~70s of 10/20/40s retries on 429s and each posted
// "Review stopped early". The wrapper replays a request only while nothing but
// progress has streamed from it, so no content is ever duplicated.
import { isRetryableStreamError, sleepMs } from '@copse/llm/stream-retry.ts'
import { hasLastUsage } from '@copse/llm/provider-usage.ts'
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamOptions,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'

/** Waits before each replay after the provider's own retries are exhausted. */
export const REVIEW_PROVIDER_BACKOFF_MS: readonly number[] = [60_000, 120_000]

export interface ProviderBackoffOptions {
  readonly delaysMs?: readonly number[]
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** In [0, 1); spreads replays from reviews that failed together. */
  readonly random?: () => number
  readonly onRetry?: (attempt: number, delayMs: number) => void
}

export function withProviderBackoff(
  inner: LLMProvider,
  options: ProviderBackoffOptions = {},
): LLMProvider {
  const delays = options.delaysMs ?? REVIEW_PROVIDER_BACKOFF_MS
  const sleep = options.sleep ?? sleepMs
  const random = options.random ?? Math.random
  const wrapped: LLMProvider = {
    async *stream(
      messages: LLMMessage[],
      tools: LLMTool[],
      signal?: AbortSignal,
      streamOptions?: LLMStreamOptions,
    ): AsyncIterable<ProviderStreamChunk> {
      for (let attempt = 0; ; attempt++) {
        let committed = false
        try {
          for await (const chunk of inner.stream(messages, tools, signal, streamOptions)) {
            if (chunk.type !== 'prompt_progress') committed = true
            yield chunk
          }
          return
        } catch (err) {
          const delay = delays[attempt]
          if (
            committed ||
            signal?.aborted === true ||
            delay === undefined ||
            !isRetryableStreamError(err)
          ) {
            throw err
          }
          const jittered = Math.round(delay * (1 + random() * 0.25))
          options.onRetry?.(attempt + 1, jittered)
          await sleep(jittered, signal)
        }
      }
    },
  }
  Object.defineProperty(wrapped, 'lastUsage', {
    get: () => (hasLastUsage(inner) ? inner.lastUsage : undefined),
    enumerable: true,
    configurable: true,
  })
  return wrapped
}
