import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { runAppProcess } from './app-run-process.ts'

describe('runAppProcess', () => {
  it('decodes a multibyte character that arrives split across output chunks', async () => {
    // "€" is E2 82 AC; the child flushes the first two bytes, then the last.
    const script = `
      process.stdout.write(Buffer.from([0x61, 0xe2, 0x82]))
      setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x62])), 150)
    `
    const logged: string[] = []
    const output = await runAppProcess(
      process.execPath,
      ['-e', script],
      tmpdir(),
      new AbortController().signal,
      { log: (text) => logged.push(text), timeoutMs: 20_000 },
    )
    assert.equal(output, 'a€b')
    assert.equal(logged.join(''), 'a€b')
  })
})
