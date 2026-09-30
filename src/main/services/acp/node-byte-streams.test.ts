import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { nodeReadableStream, nodeWritableStream } from './node-byte-streams.ts'

describe('Node byte stream bridge', () => {
  it('forwards bytes and EOF from a Node readable', async () => {
    const source = new PassThrough()
    const reader = nodeReadableStream(source).getReader()

    source.end('hello')

    const chunk = await reader.read()
    assert.equal(Buffer.from(chunk.value ?? []).toString(), 'hello')
    assert.deepEqual(await reader.read(), { value: undefined, done: true })
  })

  it('errors the reader when the source is destroyed before it ends', async () => {
    const source = new PassThrough()
    const reader = nodeReadableStream(source).getReader()

    source.write('partial')
    source.destroy()

    assert.equal(Buffer.from((await reader.read()).value ?? []).toString(), 'partial')
    await assert.rejects(reader.read(), /closed before it ended/)
  })

  it('reports the source error once, not a later premature close', async () => {
    const source = new PassThrough()
    const reader = nodeReadableStream(source).getReader()

    source.destroy(new Error('boom'))

    await assert.rejects(reader.read(), /boom/)
  })

  it('forwards bytes from a web writer to a Node writable', async () => {
    const destination = new PassThrough()
    const received: Buffer[] = []
    destination.on('data', (chunk: Buffer) => received.push(chunk))
    const writer = nodeWritableStream(destination).getWriter()

    await writer.write(Buffer.from('hello'))
    await writer.close()

    assert.equal(Buffer.concat(received).toString(), 'hello')
  })
})
