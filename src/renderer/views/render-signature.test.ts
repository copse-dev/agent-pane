import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { digestString, renderSignature } from './render-signature.ts'

describe('render-signature', () => {
  it('is stable for equal inputs and differs for changed ones', () => {
    const item = { id: 't1', status: 'done', result: 'hello world' }
    assert.equal(renderSignature(item), renderSignature({ ...item }))
    assert.notEqual(renderSignature(item), renderSignature({ ...item, status: 'running' }))
    assert.notEqual(renderSignature(item), renderSignature({ ...item, result: 'hello worlD' }))
  })

  it('stays small no matter how large the input is — the whole point (#728 cache)', () => {
    const huge = renderSignature({ result: 'x'.repeat(2_000_000) })
    assert.ok(huge.length < 40, `signature was ${String(huge.length)} chars`)
  })

  it('separates inputs that differ only in length', () => {
    assert.notEqual(digestString('ab'), digestString('ab '))
    assert.notEqual(digestString(''), digestString(' '))
  })

  it('notices a single flipped character deep inside a long payload', () => {
    const base = `${'A'.repeat(50_000)}B${'A'.repeat(50_000)}`
    const flipped = `${'A'.repeat(50_000)}C${'A'.repeat(50_000)}`
    assert.notEqual(digestString(base), digestString(flipped))
  })

  it('notices a transposition — the failure mode a single additive lane misses', () => {
    assert.notEqual(digestString('abcd'), digestString('abdc'))
    assert.notEqual(digestString('tool:read'), digestString('tool:raed'))
  })

  it('has no collisions across a wide sweep of realistic card signatures', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i++) {
      seen.add(
        renderSignature({
          id: `tool-${String(i)}`,
          status: i % 3 === 0 ? 'running' : 'done',
          args: { path: `src/file-${String(i)}.ts` },
          result: `line ${String(i)}\n`.repeat(i % 7),
        }),
      )
    }
    assert.equal(seen.size, 20_000)
  })
})
