/** Host-owned authentication: the guest can ask only the provider pinned to this run. */
import type { Duplex } from 'node:stream'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { INFERENCE_MESSAGE_LIMIT, inferenceRequestSchema } from './host-inference-wire.ts'

interface HostInferenceOptions {
  provider: (maxOutputTokens: number) => Promise<LLMProvider>
  tokenCeiling: number
  wallClockMs: number
  signal?: AbortSignal
}

export class HostInference {
  private readonly controller = new AbortController()
  private readonly timer: NodeJS.Timeout
  private readonly options: HostInferenceOptions
  private active = false
  private used = 0
  private readonly stopRequested = (): void => {
    this.stop()
  }

  constructor(options: HostInferenceOptions) {
    this.options = options
    this.timer = setTimeout(() => {
      this.stop()
    }, options.wallClockMs)
    this.timer.unref()
    options.signal?.addEventListener('abort', this.stopRequested, { once: true })
    if (options.signal?.aborted) this.stop()
  }

  stop(): void {
    clearTimeout(this.timer)
    this.options.signal?.removeEventListener('abort', this.stopRequested)
    this.controller.abort(new Error('Host inference stopped'))
  }

  async serve(stream: Duplex): Promise<void> {
    const controller = new AbortController()
    const disconnected = (): void => {
      controller.abort(new Error('Inference channel disconnected'))
    }
    stream.on('close', disconnected)
    stream.on('error', disconnected)
    const signal = AbortSignal.any([controller.signal, this.controller.signal])
    const abortStream = (): void => {
      stream.destroy()
    }
    signal.addEventListener('abort', abortStream, { once: true })
    let ownsSlot = false
    const send = (value: unknown): Promise<void> =>
      new Promise((resolve, reject) => {
        const line = JSON.stringify(value) + '\n'
        if (Buffer.byteLength(line) > INFERENCE_MESSAGE_LIMIT) {
          reject(new Error('Inference response exceeds the message limit'))
          return
        }
        stream.write(line, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    try {
      signal.throwIfAborted()
      if (this.active) throw new Error('Only one inference request may run at a time')
      this.active = true
      ownsSlot = true
      const parts: Buffer[] = []
      let bytes = 0
      for await (const part of stream) {
        const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
        bytes += buffer.length
        if (bytes > INFERENCE_MESSAGE_LIMIT)
          throw new Error('Inference request exceeds the message limit')
        parts.push(buffer)
      }
      const text = Buffer.concat(parts).toString('utf8')
      const request = safeJsonParse(text, decodeWithSchema(inferenceRequestSchema))
      if (!request) throw new Error('Invalid host inference request')
      // Reserve estimated input tokens before making a paid request. Actual usage replaces
      // this estimate; a failure with no usage keeps the reservation.
      const reservation = Math.ceil(bytes / 4)
      if (this.used + reservation >= this.options.tokenCeiling)
        throw new Error('Host inference token budget reached')
      this.used += reservation
      const provider = await this.options.provider(this.options.tokenCeiling - this.used)
      signal.throwIfAborted()
      let reported = false
      for await (const chunk of provider.stream(
        request.messages,
        request.tools,
        signal,
        request.options,
      )) {
        signal.throwIfAborted()
        if (chunk.type === 'usage') {
          if (!reported) {
            this.used -= reservation
            reported = true
          }
          this.used += chunk.inputTokens + chunk.outputTokens
        }
        await send({ chunk })
        if (this.used >= this.options.tokenCeiling)
          throw new Error('Host inference token budget reached')
      }
      await send({ end: true })
      stream.end()
    } catch (error) {
      if (!stream.destroyed) {
        const message = error instanceof Error ? error.message : 'Host inference failed'
        await send({ error: message.slice(0, 4096) }).catch(() => {})
        stream.end()
      }
    } finally {
      if (ownsSlot) this.active = false
      signal.removeEventListener('abort', abortStream)
      stream.removeListener('close', disconnected)
      stream.removeListener('error', disconnected)
    }
  }
}
