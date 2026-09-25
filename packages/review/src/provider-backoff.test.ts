import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { withProviderBackoff } from './provider-backoff.ts'

interface Attempt {
  readonly chunks: readonly ProviderStreamChunk[]
  /** Thrown after the chunks; absent for an attempt that completes. */
  readonly error?: Error
}

function scripted(attempts: readonly Attempt[]): { provider: LLMProvider; calls: () => number } {
  let call = 0
  const provider: LLMProvider = {
    async *stream() {
      const attempt = attempts[call++]
      if (attempt === undefined) throw new Error('no more attempts scripted')
      for (const chunk of attempt.chunks) yield chunk
      if (attempt.error !== undefined) throw attempt.error
    },
  }
  return { provider, calls: () => call }
}

const rateLimited = Object.assign(new Error('rate-limited upstream'), { status: 429 })
const text: ProviderStreamChunk = { type: 'text', text: 'ok' }
const progress: ProviderStreamChunk = { type: 'prompt_progress', fraction: 0.5 }

async function drain(provider: LLMProvider): Promise<ProviderStreamChunk[]> {
  const out: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream([], [])) out.push(chunk)
  return out
}

describe('withProviderBackoff', () => {
  it('replays a rate-limited request after the provider gives up, with jittered waits', async () => {
    const slept: number[] = []
    const { provider, calls } = scripted([
      { chunks: [progress], error: rateLimited },
      { chunks: [], error: rateLimited },
      { chunks: [text] },
    ])
    const wrapped = withProviderBackoff(provider, {
      delaysMs: [60_000, 120_000],
      random: () => 0.5,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      },
    })
    assert.deepEqual(await drain(wrapped), [progress, text])
    assert.equal(calls(), 3)
    assert.deepEqual(slept, [67_500, 135_000])
  })

  it('gives up after its own budget and rethrows the provider error', async () => {
    const { provider } = scripted([
      { chunks: [], error: rateLimited },
      { chunks: [], error: rateLimited },
    ])
    const wrapped = withProviderBackoff(provider, { delaysMs: [1], sleep: () => Promise.resolve() })
    await assert.rejects(drain(wrapped), /rate-limited upstream/)
  })

  it('never replays once content streamed, or for an error that is not retryable', async () => {
    const committed = scripted([{ chunks: [text], error: rateLimited }, { chunks: [text] }])
    await assert.rejects(
      drain(withProviderBackoff(committed.provider, { sleep: () => Promise.resolve() })),
      /rate-limited upstream/,
    )
    assert.equal(committed.calls(), 1, 'a replay would duplicate streamed text')
    const badRequest = scripted([
      { chunks: [], error: Object.assign(new Error('bad'), { status: 400 }) },
    ])
    await assert.rejects(
      drain(withProviderBackoff(badRequest.provider, { sleep: () => Promise.resolve() })),
      /bad/,
    )
    assert.equal(badRequest.calls(), 1)
  })
})
