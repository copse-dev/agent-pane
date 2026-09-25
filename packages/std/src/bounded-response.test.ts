import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readResponseTextWithin } from './bounded-response.ts'

function chunked(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller): void {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

describe('readResponseTextWithin', () => {
  it('reads a streamed body up to and including the limit', async () => {
    assert.equal(await readResponseTextWithin(new Response(chunked('ab', 'cd')), 4), 'abcd')
    assert.equal(await readResponseTextWithin(new Response(null), 4), '')
  })

  it('returns null past the limit, whether declared or streamed', async () => {
    assert.equal(await readResponseTextWithin(new Response(chunked('ab', 'cde')), 4), null)
    const declared = new Response(chunked('a'), { headers: { 'content-length': '5' } })
    assert.equal(await readResponseTextWithin(declared, 4), null)
  })

  it('rejects with the abort reason instead of returning a truncated body', async () => {
    const controller = new AbortController()
    const pending = readResponseTextWithin(
      new Response(new ReadableStream<Uint8Array>()),
      4,
      controller.signal,
    )
    controller.abort(new Error('deadline'))
    await assert.rejects(pending, /deadline/)
    await assert.rejects(
      readResponseTextWithin(new Response(chunked('ab')), 4, AbortSignal.abort(new Error('early'))),
      /early/,
    )
  })
})
