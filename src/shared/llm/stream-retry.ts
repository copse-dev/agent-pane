import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export const DEFAULT_STREAM_MAX_ATTEMPTS = 4

function errorHeaders(err: unknown): Headers | undefined {
  if (err instanceof Anthropic.APIError && err.headers) return err.headers
  if (err instanceof OpenAI.APIError && err.headers) return err.headers
  return undefined
}

export function isRetryableStreamError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false
  if (err instanceof OpenAI.APIUserAbortError) return false
  if (err instanceof DOMException && err.name === 'AbortError') return false
  if (err instanceof Error && err.name === 'AbortError') return false

  if (err instanceof Anthropic.RateLimitError) return true
  if (err instanceof Anthropic.APIConnectionError) return true
  if (err instanceof Anthropic.InternalServerError) return true

  if (err instanceof OpenAI.RateLimitError) return true
  if (err instanceof OpenAI.APIConnectionError) return true
  if (err instanceof OpenAI.InternalServerError) return true

  const status = (err as { status?: number })?.status
  if (status === 429 || status === 529) return true
  if (typeof status === 'number' && status >= 500 && status < 600) return true

  const body = (err as { error?: { type?: string } })?.error
  if (body?.type === 'overloaded_error') return true

  return false
}

export function streamRetryDelayMs(err: unknown, attempt: number): number {
  const headers = errorHeaders(err)
  const raw = headers?.get('retry-after') ?? headers?.get('Retry-After')
  if (raw) {
    const asNum = Number(raw)
    if (!Number.isNaN(asNum) && asNum >= 0) return Math.min(120_000, asNum * 1000)
    const asDate = Date.parse(raw)
    if (!Number.isNaN(asDate)) return Math.min(120_000, Math.max(0, asDate - Date.now()))
  }
  return Math.min(60_000, 1000 * 2 ** attempt)
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException('Aborted', 'AbortError')
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function* yieldStreamWithRetry<T>(
  run: () => AsyncIterable<T>,
  opts: { signal?: AbortSignal; maxAttempts?: number } = {},
): AsyncGenerator<T, void, unknown> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_STREAM_MAX_ATTEMPTS
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let yielded = false
    try {
      for await (const item of run()) {
        yielded = true
        yield item
      }
      return
    } catch (err) {
      if (opts.signal?.aborted) throw err
      if (yielded || !isRetryableStreamError(err) || attempt >= maxAttempts - 1) throw err
      await sleepMs(streamRetryDelayMs(err, attempt), opts.signal)
    }
  }
}
