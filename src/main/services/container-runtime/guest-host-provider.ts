import { StringDecoder } from 'node:string_decoder'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { EgressLink } from './egress-link.ts'
import {
  HOST_INFERENCE_TARGET,
  INFERENCE_MESSAGE_LIMIT,
  inferenceResponseSchema,
} from './host-inference-wire.ts'

/** No credential, endpoint or account selection crosses this channel. */
export function buildHostInferenceProvider(link: EgressLink): LLMProvider {
  return {
    async *stream(messages, tools, signal, options): AsyncIterable<ProviderStreamChunk> {
      signal?.throwIfAborted()
      const body = JSON.stringify({ messages, tools, ...(options ? { options } : {}) })
      if (Buffer.byteLength(body) > INFERENCE_MESSAGE_LIMIT)
        throw new Error('Inference request exceeds the message limit')
      const stream = await link.open(HOST_INFERENCE_TARGET)
      const abort = (): void => {
        stream.destroy(new Error('Inference cancelled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        signal?.throwIfAborted()
        stream.end(body)
        const decoder = new StringDecoder('utf8')
        let pending = ''
        let terminal: ProviderStreamChunk | undefined
        for await (const part of stream) {
          pending += Buffer.isBuffer(part) ? decoder.write(part) : String(part)
          if (Buffer.byteLength(pending) > INFERENCE_MESSAGE_LIMIT)
            throw new Error('Inference response exceeds the message limit')
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            const response = safeJsonParse(
              pending.slice(0, newline),
              decodeWithSchema(inferenceResponseSchema),
            )
            pending = pending.slice(newline + 1)
            if (!response) throw new Error('Invalid host inference response')
            if ('error' in response) throw new Error(response.error)
            if ('end' in response) {
              // Agent consumers stop iterating at done. Wait for the host's
              // completion frame so that their iterator return does not cancel
              // a provider that is still finishing its transport cleanup.
              if (terminal) yield terminal
              return
            }
            if (response.chunk.type === 'done') terminal = response.chunk
            else yield response.chunk
          }
        }
        throw new Error('Host inference channel closed before completion')
      } finally {
        signal?.removeEventListener('abort', abort)
        stream.destroy()
      }
    },
  }
}
