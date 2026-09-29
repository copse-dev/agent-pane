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
