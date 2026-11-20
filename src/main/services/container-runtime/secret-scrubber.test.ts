import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { SecretScrubber, scrubString } from './secret-scrubber.ts'

async function scrub(
  chunks: string[],
  secrets: string[],
): Promise<{ text: string; leaks: number }> {
  let leaks = 0
  const scrubber = new SecretScrubber(secrets, () => {
    leaks += 1
  })
  const parts: Buffer[] = []
  scrubber.on('data', (chunk: Buffer) => {
    parts.push(chunk)
  })
  const done = new Promise<void>((resolveDone) => {
    scrubber.on('end', () => {
      resolveDone()
    })
  })
  Readable.from(chunks.map((chunk) => Buffer.from(chunk))).pipe(scrubber)
  await done
  return { text: Buffer.concat(parts).toString('utf8'), leaks }
}

describe('SecretScrubber', () => {
  it('passes a stream with no secret through unchanged', async () => {
    const result = await scrub(['hello ', 'world'], ['ghp_secret'])
    assert.deepEqual(result, { text: 'hello world', leaks: 0 })
  })

  it('redacts a secret split across chunk boundaries, keeping the length', async () => {
    const secret = 'ghp_abcdefghijklmnop'
    for (let cut = 1; cut < secret.length; cut += 1) {
      const result = await scrub(
        [`before ${secret.slice(0, cut)}`, `${secret.slice(cut)} after`],
        [secret],
      )
      assert.equal(result.text, `before ${'*'.repeat(secret.length)} after`, String(cut))
      assert.equal(result.leaks, 1)
    }
  })

  it('redacts across many tiny chunks and repeated occurrences', async () => {
    const secret = 'tok123'
    const text = `a${secret}b${secret}${secret}c`
    const result = await scrub(
      Array.from({ length: text.length }, (_, i) => text.charAt(i)),
      [secret],
    )
    assert.equal(result.text, `a******b************c`)
    assert.equal(result.leaks, 1)
  })

  it('handles several secrets of different lengths', async () => {
    const result = await scrub(['x LONGSECRETVALUE y SHORT z'], ['SHORT', 'LONGSECRETVALUE'])
    assert.equal(result.text, `x ${'*'.repeat(15)} y ***** z`)
  })
})

describe('scrubString', () => {
  it('redacts every occurrence and says so', () => {
    assert.deepEqual(scrubString('a tok b tok', ['tok']), { value: 'a *** b ***', leaked: true })
    assert.deepEqual(scrubString('clean', ['tok', '']), { value: 'clean', leaked: false })
  })
})
