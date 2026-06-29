import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STREAM_MAX_ATTEMPTS,
  isRetryableStreamError,
  streamRetryDelayMs,
  sleepMs,
  yieldStreamWithRetry,
} from './stream-retry.ts'

/** An Error carrying an HTTP status, matching the duck-typed retry path. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

/**
 * Builds a stream factory whose iterator runs `onPull` (expected to throw) on
 * the first pull — i.e. a stream that fails before yielding anything. Modeled
 * as a plain async iterable rather than an empty `async function*`, which would
 * otherwise be a generator with no `yield`.
 */
function failingStream(onPull: () => void): () => AsyncIterable<string> {
  return () => ({
    [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
      async next(): Promise<IteratorResult<string>> {
        onPull()
        return { done: true, value: undefined }
      },
    }),
  })
}

describe('isRetryableStreamError', () => {
  it('never retries user aborts (DOMException AbortError)', () => {
    assert.equal(isRetryableStreamError(new DOMException('Aborted', 'AbortError')), false)
  })

  it('never retries a generic Error named AbortError', () => {
    const err = new Error('cancelled')
    err.name = 'AbortError'
    assert.equal(isRetryableStreamError(err), false)
  })

  it('retries 429 and 529 by status code', () => {
    assert.equal(isRetryableStreamError({ status: 429 }), true)
    assert.equal(isRetryableStreamError({ status: 529 }), true)
  })

  it('retries any 5xx status', () => {
    assert.equal(isRetryableStreamError({ status: 500 }), true)
    assert.equal(isRetryableStreamError({ status: 503 }), true)
    assert.equal(isRetryableStreamError({ status: 599 }), true)
  })

  it('does not retry 4xx (other than rate limits)', () => {
    assert.equal(isRetryableStreamError({ status: 400 }), false)
    assert.equal(isRetryableStreamError({ status: 401 }), false)
    assert.equal(isRetryableStreamError({ status: 404 }), false)
  })

  it('retries an overloaded_error body type', () => {
    assert.equal(isRetryableStreamError({ error: { type: 'overloaded_error' } }), true)
  })

  it('does not retry an unknown plain error', () => {
    assert.equal(isRetryableStreamError(new Error('boom')), false)
    assert.equal(isRetryableStreamError('boom'), false)
    assert.equal(isRetryableStreamError(undefined), false)
  })
})

describe('streamRetryDelayMs', () => {
  // Retry-After is only read off real Anthropic/OpenAI APIError instances
  // (errorHeaders narrows on those classes), so non-SDK errors always fall
  // through to exponential backoff.
  it('uses exponential backoff for plain errors', () => {
    assert.equal(streamRetryDelayMs({}, 0), 1000)
    assert.equal(streamRetryDelayMs({}, 1), 2000)
    assert.equal(streamRetryDelayMs({}, 2), 4000)
    assert.equal(streamRetryDelayMs({}, 3), 8000)
  })

  it('caps exponential backoff at 60s', () => {
    assert.equal(streamRetryDelayMs({}, 20), 60_000)
  })

  it('ignores a Retry-After-like property on a non-SDK error', () => {
    // A bare object with a headers map is NOT an SDK APIError, so the header
    // is ignored and backoff still applies.
    const err = { headers: new Headers({ 'retry-after': '5' }) }
    assert.equal(streamRetryDelayMs(err, 0), 1000)
  })
})

describe('sleepMs', () => {
  it('resolves after the delay', async () => {
    const start = Date.now()
    await sleepMs(5)
    assert.ok(Date.now() - start >= 4)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(() => sleepMs(1000, ac.signal))
  })

  it('rejects when aborted mid-sleep', async () => {
    const ac = new AbortController()
    const p = sleepMs(10_000, ac.signal)
    ac.abort()
    await assert.rejects(() => p)
  })
})

describe('yieldStreamWithRetry', () => {
  it('passes through items from a successful stream', async () => {
    async function* run(): AsyncGenerator<number> {
      yield 1
      yield 2
      yield 3
    }
    const out: number[] = []
    for await (const v of yieldStreamWithRetry(run)) out.push(v)
    assert.deepEqual(out, [1, 2, 3])
  })

  it('retries a retryable error before any item is yielded', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<string> {
      attempts++
      if (attempts === 1) throw httpError(503)
      yield 'ok'
    }
    const out: string[] = []
    for await (const v of yieldStreamWithRetry(run, { maxAttempts: 3 })) out.push(v)
    assert.deepEqual(out, ['ok'])
    assert.equal(attempts, 2)
  })

  it('does NOT retry once an item has been yielded (no duplicate output)', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<string> {
      attempts++
      yield 'partial'
      throw httpError(503)
    }
    const out: string[] = []
    await assert.rejects(async () => {
      for await (const v of yieldStreamWithRetry(run, { maxAttempts: 3 })) out.push(v)
    })
    assert.deepEqual(out, ['partial'])
    assert.equal(attempts, 1)
  })

  it('does not retry a non-retryable error', async () => {
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw httpError(400)
    })
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 3 })) void _
    })
    assert.equal(attempts, 1)
  })

  it('gives up after maxAttempts retryable failures', async () => {
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw httpError(503)
    })
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 2 })) void _
    })
    assert.equal(attempts, 2)
  })

  it('stops retrying when the signal is aborted', async () => {
    const ac = new AbortController()
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      ac.abort()
      throw httpError(503)
    })
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 5, signal: ac.signal })) void _
    })
    assert.equal(attempts, 1)
  })

  it('defaults to DEFAULT_STREAM_MAX_ATTEMPTS', () => {
    assert.equal(DEFAULT_STREAM_MAX_ATTEMPTS, 4)
  })
})
