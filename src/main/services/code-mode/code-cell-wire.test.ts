import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import {
  cellRunSchema,
  decodeLine,
  encodeLine,
  readLines,
  readMessage,
  toolCallRequestSchema,
} from './code-cell-wire.ts'

describe('readLines', () => {
  it('yields whole lines however the bytes are split', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const done = readLines(stream, (line) => lines.push(line))
    stream.write('{"a":')
    stream.write('1}\n{"b"')
    stream.write(':2}\n')
    stream.end()
    await done
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  })

  it('refuses a line longer than its limit, even before the newline arrives', async () => {
    const stream = new PassThrough()
    const done = readLines(stream, () => {}, 8)
    stream.write('0123456789')
    await assert.rejects(done, /exceeds the message limit/)
  })
})

describe('readMessage', () => {
  it('reads a stream to its end and refuses one past the limit', async () => {
    const small = new PassThrough()
    small.end('hello')
    assert.equal(await readMessage(small), 'hello')
    const large = new PassThrough()
    large.end('x'.repeat(20))
    await assert.rejects(readMessage(large, 10), /exceeds the message limit/)
  })
})

describe('messages', () => {
  it('round-trip one line and refuse unknown fields or names', () => {
    const run = { op: 'run', id: 3, code: 'return 1', timeoutMs: 1000 }
    assert.deepEqual(decodeLine(encodeLine(run).trim(), cellRunSchema), run)
    assert.equal(decodeLine(JSON.stringify({ ...run, extra: true }), cellRunSchema), null)
    assert.equal(decodeLine('not json', cellRunSchema), null)
    assert.equal(
      decodeLine(
        JSON.stringify({ cell: 1, name: '../run_shell', args: {} }),
        toolCallRequestSchema,
      ),
      null,
    )
    assert.equal(
      decodeLine(JSON.stringify({ cell: 1, name: 'read_file', args: [] }), toolCallRequestSchema),
      null,
    )
  })

  it('refuses a cell timeout past five minutes', () => {
    assert.equal(
      decodeLine(
        JSON.stringify({ op: 'run', id: 1, code: '', timeoutMs: 5 * 60_000 + 1 }),
        cellRunSchema,
      ),
      null,
    )
  })
})
