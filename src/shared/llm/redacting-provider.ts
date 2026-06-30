import type { LLMProvider, LLMMessage, LLMTool, StreamChunk } from '@shared/types'
import { redactMessages } from './redact-secrets.ts'

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
    stream(
      messages: LLMMessage[],
      tools: LLMTool[],
      signal?: AbortSignal,
    ): AsyncIterable<StreamChunk> {
      return inner.stream(redactMessages(messages, literalSecrets), tools, signal)
    },
  }
  Object.defineProperty(wrapped, 'lastUsage', {
    get: () => (inner as { lastUsage?: unknown }).lastUsage,
    enumerable: true,
    configurable: true,
  })
  return wrapped
}
