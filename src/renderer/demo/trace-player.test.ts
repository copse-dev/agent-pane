import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { StreamChunk } from '@shared/types'
import type { DemoTrace } from '@shared/demo-traces.ts'
import { playTrace, sliceForStreaming } from './trace-player.ts'

const trace: DemoTrace = {
  id: 'test',
  label: 'Test',
  prompt: 'why?',
  steps: [
    { chunk: { type: 'text', text: 'one two three four' } },
    { chunk: { type: 'tool_call', toolCall: { id: 't1', name: 'read_file', args: {} } } },
    { chunk: { type: 'tool_result', toolCallId: 't1', result: 'ok', isError: false } },
    { chunk: { type: 'done', stopReason: 'end_turn' } },
  ],
}

/** Collect emitted chunks without waiting on real timers. */
async function play(options: Parameters<typeof playTrace>[2] = {}): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  await playTrace(trace, (chunk) => seen.push(chunk), {
    sleep: () => Promise.resolve(),
    ...options,
  })
  return seen
}

describe('sliceForStreaming', () => {
  it('breaks on word boundaries so streamed text never sits mid-word', () => {
    assert.deepEqual(sliceForStreaming('alpha beta gamma', 8), ['alpha ', 'beta ', 'gamma'])
  })

  it('splits a word longer than the slice rather than emitting it whole', () => {
    assert.deepEqual(sliceForStreaming('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  })

  it('emits nothing for empty text', () => {
    assert.deepEqual(sliceForStreaming('', 8), [])
  })
})

describe('playTrace', () => {
  it('streams prose in slices while passing other chunks through whole', async () => {
    const seen = await play()
    const text = seen.filter((chunk) => chunk.type === 'text')
    assert.ok(text.length > 1, 'expected prose to arrive in more than one chunk')
    assert.equal(text.map((chunk) => chunk.text).join(''), 'one two three four')
    assert.deepEqual(
      seen.filter((chunk) => chunk.type !== 'text').map((chunk) => chunk.type),
      ['tool_call', 'tool_result', 'done'],
    )
  })

  it('still slices prose when instant, so the renderer sees the same event shape', async () => {
    const seen = await play({ instant: true })
    assert.equal(
      seen
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => chunk.text)
        .join(''),
      'one two three four',
    )
    assert.equal(seen.at(-1)?.type, 'done')
  })

  it('stops emitting once aborted — a Stop press must not keep the answer coming', async () => {
    const controller = new AbortController()
    const seen: StreamChunk[] = []
    await playTrace(
      trace,
      (chunk) => {
        seen.push(chunk)
        controller.abort()
      },
      { sleep: () => Promise.resolve(), signal: controller.signal },
    )
    assert.equal(seen.length, 1)
    assert.notEqual(seen.at(-1)?.type, 'done')
  })
})
