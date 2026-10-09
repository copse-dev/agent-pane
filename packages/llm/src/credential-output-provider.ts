import type { LLMProvider, ProviderStreamChunk } from './wire-types.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { providerStreamChunkSchema } from './provider-stream-schema.ts'

/** Do not retain an SDK exception whose body or headers may contain credentials. */
function sanitizedProviderError(error: unknown, redact: (text: string) => string): Error {
  const message = error instanceof Error ? redact(error.message) : 'Provider request failed'
  const cause = new Error(message)
  return new Error(message, { cause })
}

/** Keep authentication credentials out of streamed results, including split text deltas. */
export function withCredentialOutputRedaction(
  inner: LLMProvider,
  credentials: readonly string[],
  sanitizeError?: (error: unknown) => Error,
): LLMProvider {
  const secrets = [...new Set(credentials.filter((secret) => secret.length > 0))].sort(
    (a, b) => b.length - a.length,
  )
  const redact = (text: string): string => {
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED_SECRET]')
    return text
  }
  return {
    async *stream(messages, tools, signal, options): AsyncIterable<ProviderStreamChunk> {
      let pending = ''
      let kind: 'text' | 'reasoning' = 'text'
      try {
        for await (const chunk of inner.stream(messages, tools, signal, options)) {
          if (chunk.type === 'text' || chunk.type === 'reasoning') {
            if (chunk.type !== kind && pending) {
              yield { type: kind, text: redact(pending) }
              pending = ''
            }
            kind = chunk.type
            pending = redact(pending + chunk.text)
            let retained = 0
            for (const secret of secrets) {
              for (
                let length = Math.min(secret.length - 1, pending.length);
                length > retained;
                length--
              ) {
                if (pending.endsWith(secret.slice(0, length))) {
                  retained = length
                  break
                }
              }
            }
            const safeLength = pending.length - retained
            if (safeLength) yield { type: kind, text: pending.slice(0, safeLength) }
            pending = pending.slice(safeLength)
            continue
          }
          if (pending) {
            yield { type: kind, text: redact(pending) }
            pending = ''
          }
          const safeChunk = safeJsonParse(
            redact(JSON.stringify(chunk)),
            decodeWithSchema(providerStreamChunkSchema),
          )
          if (!safeChunk) throw new Error('Invalid credential-redacted provider response')
          yield safeChunk
        }
        if (pending) yield { type: kind, text: redact(pending) }
      } catch (error) {
        throw sanitizeError ? sanitizeError(error) : sanitizedProviderError(error, redact)
      }
    },
  }
}
