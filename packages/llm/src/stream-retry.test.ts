import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallRequestError } from '@lmstudio/sdk'
import OpenAI from 'openai'
import {
  DEFAULT_STREAM_MAX_ATTEMPTS,
  ROUTING_POLICY_RETRY_DELAY_MS,
  isImageUnsupportedError,
  isOutputCeilingRejectedError,
  isRetryableStreamError,
  streamRetryDelayMs,
  sleepMs,
  yieldStreamWithRetry,
  type StreamRetryEvent,
} from './stream-retry.ts'

/** The 404/503 message shapes OpenRouter uses for a routing-policy failure. */
function routingPolicyMessageError(variant: 'current' | 'legacy' = 'current'): Error {
  if (variant === 'legacy') {
    return Object.assign(
      new Error(
        '404 {"error":{"message":"No endpoints found matching your data policy (Zero data retention: true)","code":404}}',
      ),
      { status: 404 },
    )
  }
  return Object.assign(
    new Error(
      '503 {"error":{"message":"There is no available model provider that meets your routing requirements.","code":503}}',
    ),
    { status: 503 },
  )
}

/** An Error carrying an HTTP status, matching the duck-typed retry path. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { status })
}

function providerError(status: number, message: string, retryAfterSeconds = 0): Error {
  return new OpenAI.APIError(
    status,
    { message },
    message,
    new Headers({ 'retry-after': String(retryAfterSeconds) }),
  )
}

function routingPolicyError(status = 404, retryAfterSeconds = 0): Error {
  return providerError(
    status,
    'No endpoints found matching your data policy (Zero data retention).',
    retryAfterSeconds,
  )
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

  it('recognizes statusless OpenAI SDK errors from HTTP 200 SSE error frames', () => {
    for (const code of [429, '429', 503, '503']) {
      const error = new OpenAI.APIError(
        undefined,
        { code, message: 'temporary' },
        undefined,
        undefined,
      )
      assert.equal(error.status, undefined)
      assert.equal(isRetryableStreamError(error), true, String(code))
    }
  })

  it('does not reinterpret arbitrary codes or override an explicit HTTP status', () => {
    for (const code of [400, 401, 402, 404, 'insufficient_quota', '429oops', '', null]) {
      assert.equal(
        isRetryableStreamError(new OpenAI.APIError(undefined, { code }, undefined, undefined)),
        false,
        String(code),
      )
    }
    assert.equal(isRetryableStreamError({ code: 429 }), false)
    assert.equal(
      isRetryableStreamError(new OpenAI.APIError(401, { code: 429 }, undefined, undefined)),
      false,
    )
    assert.equal(
      isRetryableStreamError(
        new OpenAI.APIError(
          undefined,
          { code: 429 },
          undefined,
          new Headers({ 'x-should-retry': 'false' }),
        ),
      ),
      false,
    )
  })

  it('retains the SDK retry policy for request timeout and conflict statuses', () => {
    assert.equal(isRetryableStreamError({ status: 408 }), true)
    assert.equal(isRetryableStreamError({ status: 409 }), true)
  })

  it('retains explicit OpenAI server retry overrides', () => {
    const forced = new OpenAI.APIError(
      400,
      { message: 'retry this request' },
      'retry this request',
      new Headers({ 'x-should-retry': 'true' }),
    )
    const forbidden = new OpenAI.APIError(
      503,
      { message: 'do not retry this request' },
      'do not retry this request',
      new Headers({ 'x-should-retry': 'false' }),
    )
    assert.equal(isRetryableStreamError(forced), true)
    assert.equal(isRetryableStreamError(forbidden), false)
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

  it('retries an LM Studio WebSocket connection loss', () => {
    // The exact strings the SDK's WebSocket transport raises and forwards to
    // every open channel.
    assert.equal(isRetryableStreamError(new Error('WebSocket connection closed')), true)
    assert.equal(isRetryableStreamError(new Error('WebSocket timed out')), true)
    assert.equal(isRetryableStreamError(new Error('WebSocket connection failed')), true)
    assert.equal(isRetryableStreamError(new Error('Socket hang up')), true)
    assert.equal(isRetryableStreamError(new Error('connect ECONNREFUSED 127.0.0.1:1234')), true)
  })

  it('retries an LM Studio channel that closed without a result', () => {
    // A channel can end without the transport itself erroring; the prediction
    // then rejects with a bare closure rather than a socket-level message.
    assert.equal(isRetryableStreamError(new Error('Channel closed unexpectedly.')), true)
    assert.equal(
      isRetryableStreamError(new Error('Channel closed before receiving a result.')),
      true,
    )
  })

  it('does not retry an LM Studio tool-call parse failure', () => {
    // ToolCallRequestError means the model produced an unparseable tool call —
    // deterministic, so a replay would fail the same way.
    const err = new ToolCallRequestError('tool call arguments were not valid JSON', undefined)
    assert.equal(isRetryableStreamError(err), false)
  })

  it('does not retry an unknown LM Studio protocol error', () => {
    assert.equal(isRetryableStreamError(new Error('LM Studio: model failed to load')), false)
  })

  it('excludes an OpenRouter routing-policy failure from the blind retry loop, even as a 5xx (it gets its own dedicated retry instead — see the yieldStreamWithRetry tests below)', () => {
    const current = Object.assign(
      new Error(
        '503 {"error":{"message":"There is no available model provider that meets your routing requirements.","code":503}}',
      ),
      { status: 503 },
    )
    assert.equal(isRetryableStreamError(current), false)
    const legacy = Object.assign(
      new Error(
        '404 {"error":{"message":"No endpoints found matching your data policy (Zero data retention: true)","code":404}}',
      ),
      { status: 404 },
    )
    assert.equal(isRetryableStreamError(legacy), false)
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

  it('gives streamed rate limits a bounded cooldown with jitter', (t) => {
    const random = t.mock.method(Math, 'random', () => 0)
    for (const code of [429, '429']) {
      const error = new OpenAI.APIError(undefined, { code }, undefined, undefined)
      assert.deepEqual(
        [0, 1, 2].map((attempt) => streamRetryDelayMs(error, attempt)),
        [10_000, 20_000, 40_000],
      )
    }
    random.mock.mockImplementation(() => 0.999)
    const error = new OpenAI.APIError(undefined, { code: 429 }, undefined, undefined)
    assert.ok(streamRetryDelayMs(error, 0) > 10_000)
    assert.ok(streamRetryDelayMs(error, 0) < 11_000)
    assert.equal(streamRetryDelayMs(error, 20), 60_000)
    assert.equal(streamRetryDelayMs({ code: 429 }, 0), 1000)
    assert.equal(
      streamRetryDelayMs(new OpenAI.APIError(503, { code: 429 }, '', undefined), 0),
      1000,
    )
  })

  it('honors a server delay before the streamed rate-limit cooldown', () => {
    const error = new OpenAI.APIError(
      undefined,
      { code: 429 },
      undefined,
      new Headers({ 'retry-after': '3' }),
    )
    assert.equal(streamRetryDelayMs(error, 0), 3000)
  })

  it('ignores a Retry-After-like property on a non-SDK error', () => {
    // A bare object with a headers map is NOT an SDK APIError, so the header
    // is ignored and backoff still applies.
    const err = { headers: new Headers({ 'retry-after': '5' }) }
    assert.equal(streamRetryDelayMs(err, 0), 1000)
  })

  it('preserves the SDK retry-after-ms override with a bounded finite delay', () => {
    const error = new OpenAI.APIError(
      503,
      { message: 'temporary' },
      'temporary',
      new Headers({ 'retry-after': '9', 'retry-after-ms': '125' }),
    )
    assert.equal(streamRetryDelayMs(error, 0), 125)

    const capped = new OpenAI.APIError(
      503,
      { message: 'temporary' },
      'temporary',
      new Headers({ 'retry-after-ms': '999999' }),
    )
    assert.equal(streamRetryDelayMs(capped, 0), 120_000)

    const invalid = new OpenAI.APIError(
      503,
      { message: 'temporary' },
      'temporary',
      new Headers({ 'retry-after': '2', 'retry-after-ms': 'Infinity' }),
    )
    assert.equal(streamRetryDelayMs(invalid, 0), 2000)
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
  it('recovers after a minute of streamed throttling without increasing the attempt budget', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    t.mock.method(Math, 'random', () => 0)
    t.mock.method(console, 'warn', () => {})
    const attempts: number[] = []
    async function* run(): AsyncGenerator<string> {
      attempts.push(Date.now())
      if (Date.now() < 60_000) {
        throw new OpenAI.APIError(undefined, { code: 429 }, undefined, undefined)
      }
      yield 'ok'
    }
    const result = (async (): Promise<string[]> => {
      const output: string[] = []
      for await (const item of yieldStreamWithRetry(run)) output.push(item)
      return output
    })().then(
      (output) => ({ output, error: undefined }),
      (error: unknown) => ({ output: [], error }),
    )
    // Let async iteration reach each timer; no wall-clock minute or network call.
    await new Promise<void>((resolve) => setImmediate(resolve))
    for (let second = 0; second < 75; second++) {
      t.mock.timers.tick(1000)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.deepEqual(await result, { output: ['ok'], error: undefined })
    assert.deepEqual(attempts, [0, 10_000, 30_000, 70_000])
  })

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

  it('retries a routing-policy failure once and logs recovery without provider contents', async () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      let attempts = 0
      async function* run(): AsyncGenerator<string> {
        attempts++
        if (attempts === 1) throw routingPolicyError()
        yield 'ok'
      }

      const out: string[] = []
      for await (const value of yieldStreamWithRetry(run, { maxAttempts: 4 })) {
        out.push(value)
      }

      assert.deepEqual(out, ['ok'])
      assert.equal(attempts, 2)
      assert.equal(warn.mock.callCount(), 1)
      const call = warn.mock.calls[0]
      assert.ok(call)
      assert.deepEqual(call.arguments, ['[llm] routing-policy retry succeeded'])
    } finally {
      warn.mock.restore()
    }
  })

  it('stops after one repeated routing-policy failure and logs the terminal outcome', async () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      let attempts = 0
      const run = failingStream(() => {
        attempts++
        throw routingPolicyError(503)
      })

      await assert.rejects(async () => {
        for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 4 })) {
          // Drain until the second policy failure terminates the stream.
        }
      }, /No OpenRouter endpoint/)

      assert.equal(attempts, 2)
      assert.equal(warn.mock.callCount(), 1)
      const call = warn.mock.calls[0]
      assert.ok(call)
      assert.deepEqual(call.arguments, ['[llm] routing-policy retry failed'])
    } finally {
      warn.mock.restore()
    }
  })

  it('does not retry an unrelated 404', async () => {
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw httpError(404)
    })

    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 4 })) {
        // Drain until the unrelated client error terminates the stream.
      }
    })

    assert.equal(attempts, 1)
  })

  it('gives routing-policy 503 one replay while generic 503 uses the normal budget', async () => {
    let routingAttempts = 0
    const routing = failingStream(() => {
      routingAttempts++
      throw routingPolicyError(503)
    })
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(routing, { maxAttempts: 4 })) {
        // Drain until the second policy failure terminates the stream.
      }
    })

    let genericAttempts = 0
    const generic = failingStream(() => {
      genericAttempts++
      throw providerError(503, 'temporary provider failure')
    })
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(generic, { maxAttempts: 4 })) {
        // Drain until the generic retry budget is exhausted.
      }
    })

    assert.equal(routingAttempts, 2)
    assert.equal(genericAttempts, 4)
  })

  it('allows the dedicated policy retry at the generic attempt limit', async () => {
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw routingPolicyError()
    })

    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 1 })) {
        // The policy replay has a separate budget from generic retries.
      }
    })

    assert.equal(attempts, 2)
  })

  it('allows one policy replay after a generic failure on its separate budget', async () => {
    const errors = [
      providerError(503, 'temporary provider failure'),
      routingPolicyError(),
      providerError(503, 'temporary provider failure'),
      routingPolicyError(),
    ]
    let attempts = 0
    const run = failingStream(() => {
      const err = errors[attempts]
      attempts++
      assert.ok(err)
      throw err
    })

    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 6 })) {
        // Drain until the second policy failure terminates the stream.
      }
    }, /No OpenRouter endpoint/)

    // The second policy failure is terminal even though generic retries remain.
    assert.equal(attempts, 4)
  })

  it('can recover from a generic failure during the one policy replay', async () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      let attempts = 0
      async function* run(): AsyncGenerator<string> {
        attempts++
        if (attempts === 1) throw routingPolicyError()
        if (attempts === 2) throw providerError(503, 'temporary provider failure')
        yield 'ok'
      }

      const out: string[] = []
      for await (const value of yieldStreamWithRetry(run, { maxAttempts: 4 })) out.push(value)

      assert.deepEqual(out, ['ok'])
      assert.equal(attempts, 3)
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [['[llm] routing-policy retry failed']],
      )
    } finally {
      warn.mock.restore()
    }
  })

  it('keeps generic failures during the policy replay within their own cap', async () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      let attempts = 0
      const run = failingStream(() => {
        attempts++
        if (attempts === 1) throw routingPolicyError()
        throw providerError(503, 'temporary provider failure')
      })

      await assert.rejects(async () => {
        for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 4 })) {
          // Drain until the generic retry budget is exhausted.
        }
      }, /temporary provider failure/)

      assert.equal(attempts, 5)
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [['[llm] routing-policy retry failed']],
      )
    } finally {
      warn.mock.restore()
    }
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

  it('does not retry a routing-policy failure after stream content', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<string> {
      attempts++
      yield 'partial'
      throw routingPolicyError()
    }

    const out: string[] = []
    await assert.rejects(async () => {
      for await (const value of yieldStreamWithRetry(run, { maxAttempts: 4 })) {
        out.push(value)
      }
    })

    assert.deepEqual(out, ['partial'])
    assert.equal(attempts, 1)
  })

  it('retries after only progress-shaped items were yielded (no content lost)', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<{ type: string; fraction?: number; text?: string }> {
      attempts++
      if (attempts === 1) {
        yield { type: 'prompt_progress', fraction: 0.4 }
        throw httpError(503)
      }
      yield { type: 'prompt_progress', fraction: 0.9 }
      yield { type: 'text', text: 'ok' }
    }
    const out: Array<{ type: string; fraction?: number; text?: string }> = []
    for await (const v of yieldStreamWithRetry(run, { maxAttempts: 3 })) out.push(v)
    // Progress-only yields do not pin the attempt, so the stream recovers
    // instead of failing. Already-delivered progress cannot be unsent — it is
    // ephemeral display state, and the replay simply supersedes it.
    assert.deepEqual(out, [
      { type: 'prompt_progress', fraction: 0.4 },
      { type: 'prompt_progress', fraction: 0.9 },
      { type: 'text', text: 'ok' },
    ])
    assert.equal(attempts, 2)
  })

  it('does not retry a non-retryable error', async () => {
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw httpError(400)
    })
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 3 })) {
        // Drain until the stream raises the expected error.
      }
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
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 2 })) {
        // Drain until the stream raises the expected error.
      }
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
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 5, signal: ac.signal })) {
        // Drain until the stream raises the expected error.
      }
    })
    assert.equal(attempts, 1)
  })

  it('cancels a routing-policy retry during its delay', async () => {
    const ac = new AbortController()
    const timer = setTimeout(() => {
      ac.abort()
    }, 10)
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw routingPolicyError(404, 1)
    })

    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, {
        maxAttempts: 4,
        signal: ac.signal,
      })) {
        // Drain until cancellation interrupts the backoff.
      }
    }, /Abort/)
    clearTimeout(timer)

    assert.equal(attempts, 1)
  })

  it('logs cancellation instead of failure when the policy replay is aborted', async () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      const ac = new AbortController()
      let attempts = 0
      async function* run(): AsyncGenerator<string> {
        attempts++
        if (attempts === 1) throw routingPolicyError()
        ac.abort()
        yield await Promise.reject(new DOMException('Aborted', 'AbortError'))
      }

      await assert.rejects(async () => {
        for await (const _ of yieldStreamWithRetry(run, {
          maxAttempts: 4,
          signal: ac.signal,
        })) {
          // Drain until cancellation terminates the policy replay.
        }
      }, /Abort/)

      assert.equal(attempts, 2)
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        [['[llm] routing-policy retry cancelled']],
      )
    } finally {
      warn.mock.restore()
    }
  })

  it('defaults to DEFAULT_STREAM_MAX_ATTEMPTS', () => {
    assert.equal(DEFAULT_STREAM_MAX_ATTEMPTS, 4)
  })
})

describe('yieldStreamWithRetry — routing-policy failure (#1876)', () => {
  it('retries a routing-policy failure exactly once, after a delay, then succeeds', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<string> {
      attempts++
      if (attempts === 1) throw routingPolicyMessageError()
      yield 'ok'
    }
    const start = Date.now()
    const out: string[] = []
    for await (const v of yieldStreamWithRetry(run)) out.push(v)
    assert.deepEqual(out, ['ok'])
    assert.equal(attempts, 2)
    assert.ok(Date.now() - start >= ROUTING_POLICY_RETRY_DELAY_MS - 5)
  })

  it('retries the legacy 404 "no endpoints found" form the same way', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<string> {
      attempts++
      if (attempts === 1) throw routingPolicyMessageError('legacy')
      yield 'ok'
    }
    const out: string[] = []
    for await (const v of yieldStreamWithRetry(run)) out.push(v)
    assert.deepEqual(out, ['ok'])
    assert.equal(attempts, 2)
  })

  it('gives up after the one retry: exactly 2 attempts total, never an unbounded loop', async () => {
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw routingPolicyMessageError()
    })
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run)) {
        // Drain until the terminal error is thrown.
      }
    })
    assert.equal(attempts, 2)
  })

  it('the terminal error names the model and the conflicting settings, not just the raw provider string', async () => {
    const run = failingStream(() => {
      throw routingPolicyMessageError()
    })
    await assert.rejects(
      async () => {
        for await (const _ of yieldStreamWithRetry(run, {
          modelId: 'meta-llama/llama-3.1-70b-instruct:free',
        })) {
          // Drain until the terminal error is thrown.
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /meta-llama\/llama-3\.1-70b-instruct:free/)
        assert.match(err.message, /ZDR only/)
        assert.match(err.message, /No training/)
        assert.ok(err.cause instanceof Error)
        return true
      },
    )
  })

  it('does not let the dedicated routing-policy retry consume or extend the generic retry budget', async () => {
    let attempts = 0
    const run = failingStream(() => {
      attempts++
      throw routingPolicyMessageError()
    })
    // A generic budget of 1 permits zero generic retries, yet the dedicated
    // routing-policy retry still fires exactly once — the two budgets are
    // independent.
    await assert.rejects(async () => {
      for await (const _ of yieldStreamWithRetry(run, { maxAttempts: 1 })) {
        // Drain until the terminal error is thrown.
      }
    })
    assert.equal(attempts, 2)
  })

  it('does not retry a routing-policy failure once content has been committed', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<string> {
      attempts++
      yield 'partial'
      throw routingPolicyMessageError()
    }
    const out: string[] = []
    await assert.rejects(async () => {
      for await (const v of yieldStreamWithRetry(run)) out.push(v)
    })
    assert.deepEqual(out, ['partial'])
    assert.equal(attempts, 1)
  })

  it('reports the retry through onRetry before sleeping, with the routing-policy kind and delay', async () => {
    let attempts = 0
    const events: StreamRetryEvent[] = []
    async function* run(): AsyncGenerator<string> {
      attempts++
      if (attempts === 1) throw routingPolicyMessageError()
      yield 'ok'
    }
    for await (const _ of yieldStreamWithRetry(run, { onRetry: (e) => events.push(e) })) {
      // Drain the successful retry.
    }
    assert.equal(events.length, 1)
    assert.equal(events[0]?.kind, 'routing-policy')
    assert.equal(events[0].delayMs, ROUTING_POLICY_RETRY_DELAY_MS)
  })

  it('leaves generic retryable errors retrying exactly as before, unaffected by the routing-policy path', async () => {
    let attempts = 0
    async function* run(): AsyncGenerator<string> {
      attempts++
      if (attempts < 3) throw httpError(503)
      yield 'ok'
    }
    const events: StreamRetryEvent[] = []
    const out: string[] = []
    for await (const v of yieldStreamWithRetry(run, {
      maxAttempts: 4,
      onRetry: (e) => events.push(e),
    })) {
      out.push(v)
    }
    assert.deepEqual(out, ['ok'])
    assert.equal(attempts, 3)
    assert.deepEqual(
      events.map((e) => e.kind),
      ['transient', 'transient'],
    )
  })
})

describe('isImageUnsupportedError', () => {
  it('matches LM Studio rejecting an image payload', () => {
    const err = Object.assign(new Error("'url' field must be a base64 encoded image."), {
      status: 400,
    })
    assert.equal(isImageUnsupportedError(err), true)
  })

  it('matches a server that says it has no vision', () => {
    const err = Object.assign(new Error('this model does not support image input'), { status: 400 })
    assert.equal(isImageUnsupportedError(err), true)
  })

  it('ignores unrelated 400s, so images are never stripped by mistake', () => {
    const err = Object.assign(new Error('context length exceeded'), { status: 400 })
    assert.equal(isImageUnsupportedError(err), false)
  })

  it('ignores retryable statuses even when the message mentions images', () => {
    const err = Object.assign(new Error('invalid image'), { status: 500 })
    assert.equal(isImageUnsupportedError(err), false)
  })

  it('is not treated as a plain retry — replaying it unchanged would fail again', () => {
    const err = Object.assign(new Error("'url' field must be a base64 encoded image."), {
      status: 400,
    })
    assert.equal(isRetryableStreamError(err), false)
  })
})

describe('isOutputCeilingRejectedError', () => {
  it('matches a server refusing the max_tokens we sent', () => {
    const err = Object.assign(
      new Error('max_tokens is too large: 384000. This model supports at most 65536.'),
      { status: 400 },
    )
    assert.equal(isOutputCeilingRejectedError(err), true)
  })

  it('matches the other spellings of the same field', () => {
    for (const message of [
      'Invalid value for max_completion_tokens',
      'max_output_tokens exceeds the limit for this model',
      'requested maximum output tokens exceeds model limit',
    ]) {
      assert.equal(
        isOutputCeilingRejectedError(Object.assign(new Error(message), { status: 422 })),
        true,
      )
    }
  })

  it('ignores a 400 that names something else, so a ceiling is never dropped by mistake', () => {
    const err = Object.assign(new Error('context length exceeded'), { status: 400 })
    assert.equal(isOutputCeilingRejectedError(err), false)
  })

  it('ignores retryable statuses even when the message names the field', () => {
    const err = Object.assign(new Error('max_tokens is too large'), { status: 500 })
    assert.equal(isOutputCeilingRejectedError(err), false)
  })

  it('is not treated as a plain retry — the same body would be rejected again', () => {
    const err = Object.assign(new Error('max_tokens is too large'), { status: 400 })
    assert.equal(isRetryableStreamError(err), false)
  })
})
