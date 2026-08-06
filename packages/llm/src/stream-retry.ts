import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export const DEFAULT_STREAM_MAX_ATTEMPTS = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Duck-typed HTTP status on SDK / proxy errors (and plain `{ status }` test doubles). */
function errorStatus(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined
  const status = err['status']
  return typeof status === 'number' ? status : undefined
}

/** Duck-typed `{ error: { type } }` body used by Anthropic-style overloaded responses. */
function errorBodyType(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined
  const body = err['error']
  if (!isRecord(body)) return undefined
  const type = body['type']
  return typeof type === 'string' ? type : undefined
}

function errorHeaders(err: unknown): Headers | undefined {
  // Both SDKs type APIError.headers via an unconstrained generic (`any` here);
  // the `instanceof Headers` guard narrows it to the runtime Fetch `Headers`.
  if (err instanceof Anthropic.APIError && err.headers instanceof Headers) return err.headers
  if (err instanceof OpenAI.APIError && err.headers instanceof Headers) return err.headers
  return undefined
}

/**
 * OpenRouter's routing-policy failure: no endpoint satisfies the request's
 * provider constraints (e.g. ZDR-only routing via `provider.zdr`, or
 * `data_collection: "deny"`). Deterministic — the same request always fails —
 * so retrying only adds latency. Served as a 503 ("There is no available model
 * provider that meets your routing requirements"); older responses used a 404
 * "No endpoints found matching your data policy" form. Matched on message
 * because it would otherwise fall into the retryable-5xx bucket below.
 */
export function isRoutingPolicyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /no available model provider that meets your routing requirements|no endpoints found matching your data policy/i.test(
    err.message,
  )
}

/**
 * The server rejected the request because of an image in it.
 *
 * Two causes, indistinguishable from the response: the model has no vision at
 * all, or the server only accepts certain encodings. OpenAI-compatible local
 * servers surface both as a 400 — LM Studio's is
 * `'url' field must be a base64 encoded image`. Deterministic, so a plain retry
 * would only fail again; the caller retries *without* the images instead.
 *
 * Matched narrowly on message: a false positive would silently strip images
 * from a request that could have carried them.
 */
export function isImageUnsupportedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = errorStatus(err)
  if (status !== 400 && status !== 415 && status !== 422) return false
  return /must be a base64 encoded image|image_url|invalid image|unsupported image|does not support image|no vision|not a vision model/i.test(
    err.message,
  )
}

/**
 * The server rejected the request's output ceiling (`max_tokens`).
 *
 * We only ever send one when a model card publishes it, and a card is written
 * against the vendor's own API — an aggregator or a self-hosted server may serve
 * the same weights with a lower cap and reject the number outright. Deterministic,
 * so the caller retries *without* the field and lets the server's default stand
 * rather than failing a turn over a ceiling nobody asked for.
 *
 * Matched narrowly: the message must name the field, so an unrelated 400 cannot
 * silently drop a limit that was being honoured.
 */
export function isOutputCeilingRejectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = errorStatus(err)
  if (status !== 400 && status !== 422) return false
  return /max_tokens|max_completion_tokens|max_output_tokens|maximum output tokens/i.test(
    err.message,
  )
}

export function isRetryableStreamError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false
  if (err instanceof OpenAI.APIUserAbortError) return false
  if (err instanceof DOMException && err.name === 'AbortError') return false
  if (err instanceof Error && err.name === 'AbortError') return false

  if (isRoutingPolicyError(err)) return false

  if (err instanceof Anthropic.RateLimitError) return true
  if (err instanceof Anthropic.APIConnectionError) return true
  if (err instanceof Anthropic.InternalServerError) return true

  if (err instanceof OpenAI.RateLimitError) return true
  if (err instanceof OpenAI.APIConnectionError) return true
  if (err instanceof OpenAI.InternalServerError) return true

  const status = errorStatus(err)
  if (status === 429 || status === 529) return true
  if (status !== undefined && status >= 500 && status < 600) return true

  if (errorBodyType(err) === 'overloaded_error') return true

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
  const reason: unknown = signal?.reason
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
    const onAbort = (): void => {
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
