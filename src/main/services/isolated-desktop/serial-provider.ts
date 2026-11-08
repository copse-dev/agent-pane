import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'

/** The desktop's chat and auxiliary tasks share one bounded parent inference slot. */
export function serialDesktopProvider(provider: LLMProvider): LLMProvider {
  let tail = Promise.resolve()
  return {
    async *stream(messages, tools, signal, options): AsyncIterable<ProviderStreamChunk> {
      signal?.throwIfAborted()
      const previous = tail
      let release = (): void => {}
      const lease = new Promise<void>((resolve) => {
        release = resolve
      })
      // A cancelled waiter must not let its successors overtake the active request.
      tail = previous.then(() => lease)
      let abort = (): void => {}
      const ready = new Promise<void>((resolve) => {
        abort = resolve
        signal?.addEventListener('abort', abort, { once: true })
        void previous.then(resolve)
      })
      try {
        await ready
        signal?.throwIfAborted()
        yield* provider.stream(messages, tools, signal, options)
      } finally {
        signal?.removeEventListener('abort', abort)
        release()
      }
    },
  }
}
