import type {
  LLMProvider,
  LLMMessage,
  LLMStreamOptions,
  LLMTool,
  ProviderStreamChunk,
} from './wire-types.ts'
import { redactMessages, redactSecrets } from './redact-secrets.ts'
import { hasLastUsage } from './provider-usage.ts'

/**
 * Wrap a remote (cloud) {@link LLMProvider} so that every message is run through
 * deterministic on-device secret redaction before it is streamed to the third
 * party (issue #518). Local providers are never wrapped, so on-device flows keep
 * seeing real tokens.
 *
 * `literalSecrets` lets the caller additionally redact known literal credentials
 * (e.g. the user's configured provider keys) on top of the built-in pattern set.
 */
export function withSecretRedaction(
  inner: LLMProvider,
  literalSecrets: readonly string[] = [],
): LLMProvider {
  const wrapped: LLMProvider & { lastUsage?: unknown } = {
    async *stream(
      messages: LLMMessage[],
      tools: LLMTool[],
      signal?: AbortSignal,
      options?: LLMStreamOptions,
    ): AsyncIterable<ProviderStreamChunk> {
      for await (const chunk of inner.stream(
        redactMessages(messages, literalSecrets),
        tools,
        signal,
        options,
      )) {
        yield chunk.type === 'usage' && chunk.hostingProvider !== undefined
          ? { ...chunk, hostingProvider: redactSecrets(chunk.hostingProvider, literalSecrets) }
          : chunk
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
