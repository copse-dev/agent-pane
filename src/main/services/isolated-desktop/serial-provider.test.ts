import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { serialDesktopProvider } from './serial-provider.ts'

async function collect(
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<ProviderStreamChunk[]> {
  return Array.fromAsync(provider.stream([{ role: 'user', content: 'Hello' }], [], signal))
}

it('serializes chat and auxiliary requests and skips cancelled waiters without overtaking', async () => {
  const started = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  let calls = 0
  let active = 0
  let maximum = 0
  const provider = serialDesktopProvider({
    async *stream() {
      calls++
      active++
      maximum = Math.max(maximum, active)
      try {
        if (calls === 1) {
          started.resolve(undefined)
          await finish.promise
        }
        yield { type: 'done', stopReason: 'end_turn' }
      } finally {
        active--
      }
    },
  })
  const first = collect(provider)
  await started.promise
  const cancellation = new AbortController()
  const second = collect(provider, cancellation.signal)
  const rejected = assert.rejects(second, /cancel queued/)
  const third = collect(provider)
  cancellation.abort(new Error('cancel queued'))
  await rejected
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  finish.resolve(undefined)
  await Promise.all([first, third])
  assert.equal(calls, 2)
  assert.equal(maximum, 1)
})

it('releases the queue after provider failure and consumer early return', async () => {
  let calls = 0
  let closed = 0
  const provider = serialDesktopProvider({
    async *stream() {
      calls++
      try {
        if (calls === 1) throw new Error('provider failed')
        yield { type: 'text', text: 'Hello' }
        yield { type: 'done', stopReason: 'end_turn' }
      } finally {
        closed++
      }
    },
  })
  await assert.rejects(collect(provider), /provider failed/)
  for await (const chunk of provider.stream([], [])) {
    assert.equal(chunk.type, 'text')
    break
  }
  assert.equal((await collect(provider)).length, 2)
  assert.equal(closed, 3)
})
