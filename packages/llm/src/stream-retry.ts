import Anthropic from '@anthropic-ai/sdk'
import { ToolCallRequestError } from '@lmstudio/sdk'
import OpenAI from 'openai'
import { isRecord } from '@copse/std/unknown-value.ts'

export const DEFAULT_STREAM_MAX_ATTEMPTS = 4

/**
 * A connection-level failure from LM Studio's native SDK transport.
 *
 * The SDK speaks its own WebSocket protocol rather than HTTP, so its failures
 * carry neither an SDK error class nor a numeric status — a dropped server
 * surfaces as a plain Error whose message names the socket layer. Matched on
 * message for that reason. Two shapes reach a prediction: the transport error
 * itself, forwarded verbatim to every open channel ("WebSocket connection
 * closed", "WebSocket timed out", or the raw `ECONNREFUSED`), and a bare
 * channel closure when the channel ends without a result ("Channel closed
 * unexpectedly."). Deliberately narrow: a false positive retries a request that
 * could never succeed, and deterministic failures such as
 * {@link ToolCallRequestError} (the model produced an unparseable tool call)
 * must fall through to the no-retry default.
 */
export function isLmStudioTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /websocket|channel closed|socket hang up|econnrefused|econnreset|epipe|etimedout|ehostunreach|enet(unreachable|down)/i.test(
    err.message,
  )
}

/** Duck-typed HTTP status on SDK / proxy errors (and plain `{ status }` test doubles). */
function errorStatus(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined
  const status = err['status']
  return typeof status === 'number' ? status : undefined
}

/**
 * OpenAI's SDK raises an APIError with no HTTP status for an SSE error frame.
 * OpenRouter puts the status in `error.code`, including numeric codes that the
 * SDK types as strings. Only interpret HTTP-shaped codes on that SDK error;
 * an explicit HTTP status and symbolic API codes retain their usual meaning.
 */
function streamedErrorStatus(err: unknown): number | undefined {
  if (!(err instanceof OpenAI.APIError) || err.status !== undefined) return undefined
  const code: unknown = err.code
  const status = typeof code === 'string' && /^[45]\d{2}$/.test(code) ? Number(code) : code
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : undefined
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
 * `data_collection: "deny"`). Usually this means no configured endpoint can
 * serve the request, but OpenRouter can also return it transiently while its
 * eligible endpoint set changes. The stream runner therefore gives it one
 * bounded retry rather than the full generic retry budget. Served as a 503
 * ("There is no available model provider that meets your routing
 * requirements"); older responses used a 404 "No endpoints found matching
 * your data policy" form. Matched on message because the legacy 404 would not
 * otherwise enter the retry path.
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

/**
 * A stream that stopped because something aborted it, rather than because
 * anything went wrong.
 *
 * Worth a named check because the shapes do not agree: the SDKs raise their own
 * classes, whose `name` is a plain `'Error'`, while the raw-fetch transports
 * raise a `DOMException` named `AbortError`. Anything matching on `name` alone
 * silently misses every cloud provider.
 */
export function isStreamAbortError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return true
  if (err instanceof OpenAI.APIUserAbortError) return true
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

export function isRetryableStreamError(err: unknown): boolean {
  if (isStreamAbortError(err)) return false

  if (isRoutingPolicyError(err)) return false

  // Preserve the OpenAI SDK's explicit server override now that its internal
  // retry loop is disabled in our adapters. A routing-policy error stays out
  // of this generic bucket above and receives only its one special replay.
  const shouldRetry = errorHeaders(err)?.get('x-should-retry')
  if (shouldRetry === 'false') return false
  if (shouldRetry === 'true') return true

  if (err instanceof Anthropic.RateLimitError) return true
  if (err instanceof Anthropic.APIConnectionError) return true
  if (err instanceof Anthropic.InternalServerError) return true

  if (err instanceof OpenAI.RateLimitError) return true
  if (err instanceof OpenAI.APIConnectionError) return true
  if (err instanceof OpenAI.InternalServerError) return true

  // The native LM Studio transport reports connection loss as a plain Error —
  // no status code or SDK class to dispatch on (see isLmStudioTransportError).
  if (!(err instanceof ToolCallRequestError) && isLmStudioTransportError(err)) return true

  const status = errorStatus(err) ?? streamedErrorStatus(err)
  // OpenAI's SDK retries request timeout/conflict by default. Its internal
  // retry loop is disabled in our adapters so this wrapper owns one bounded
  // budget; retain those SDK semantics here alongside rate limits.
  if (status === 408 || status === 409 || status === 429 || status === 529) return true
  if (status !== undefined && status >= 500 && status < 600) return true

  if (errorBodyType(err) === 'overloaded_error') return true

  return false
}

export function streamRetryDelayMs(err: unknown, attempt: number): number {
  const headers = errorHeaders(err)
  const rawMs = headers?.get('retry-after-ms')
  if (rawMs) {
    const asNum = Number(rawMs)
    if (Number.isFinite(asNum) && asNum >= 0) return Math.min(120_000, asNum)
  }
  const raw = headers?.get('retry-after') ?? headers?.get('Retry-After')
  if (raw) {
    const asNum = Number(raw)
    if (Number.isFinite(asNum) && asNum >= 0) return Math.min(120_000, asNum * 1000)
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

/**
 * Whether `item` carries only ephemeral progress and no stream content. The
 * unknown bound keeps this module decoupled from the provider chunk union;
 * progress-shaped items are recognised structurally.
 */
function isProgressOnly(item: unknown): boolean {
  return (
    isRecord(item) && item['type'] === 'prompt_progress' && typeof item['fraction'] === 'number'
  )
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
  let routingPolicyRetryUsed = false
  let reportingRoutingPolicyOutcome = false
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Progress-only items do not commit the stream: nothing user-visible has
    // been produced, so replaying from scratch after a retryable failure is
    // safe and loses no output. Content (text/tool calls) still pins the
    // attempt, because a retry would duplicate it.
    let committed = false
    try {
      for await (const item of run()) {
        if (!isProgressOnly(item)) committed = true
        yield item
      }
      if (reportingRoutingPolicyOutcome) {
        // Deliberately omit the provider error and request: this diagnostic
        // measures whether the replay helped without copying prompt contents
        // or policy details into logs. console.warn is stderr, preserving ACP's
        // stdout-framed protocol.
        console.warn('[llm] routing-policy retry succeeded')
      }
      return
    } catch (err) {
      if (reportingRoutingPolicyOutcome) {
        const cancelled = opts.signal?.aborted === true || isStreamAbortError(err)
        console.warn(
          cancelled ? '[llm] routing-policy retry cancelled' : '[llm] routing-policy retry failed',
        )
        reportingRoutingPolicyOutcome = false
      }
      if (opts.signal?.aborted) throw err
      const routingPolicyFailure = isRoutingPolicyError(err)
      const canRetryRoutingPolicy = routingPolicyFailure && !routingPolicyRetryUsed
      const retry =
        !committed &&
        (canRetryRoutingPolicy || isRetryableStreamError(err)) &&
        attempt < maxAttempts - 1
      const streamedStatus = streamedErrorStatus(err)
      if (streamedStatus !== undefined) {
        // No request, body, headers, or provider message: enough to distinguish
        // exhaustion from a committed stream without logging private content.
        console.warn(
          `[llm] streamed API error code=${String(streamedStatus)} attempt=${String(attempt + 1)}/${String(maxAttempts)} committed=${String(committed)} retry=${String(retry)}`,
        )
      }
      if (!retry) throw err
      if (routingPolicyFailure) {
        routingPolicyRetryUsed = true
        reportingRoutingPolicyOutcome = true
      }
      try {
        await sleepMs(streamRetryDelayMs(err, attempt), opts.signal)
      } catch (sleepError) {
        if (routingPolicyFailure) {
          console.warn('[llm] routing-policy retry cancelled')
        }
        throw sleepError
      }
    }
  }
}
