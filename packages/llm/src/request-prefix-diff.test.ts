import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareRequestPrefix, describeDivergence } from './request-prefix-diff.ts'

const base = { model: 'gpt-5', tools: [{ name: 'a' }, { name: 'b' }], input: ['x', 'y'] }

describe('compareRequestPrefix', () => {
  it('accepts appended input and ignores the output ceiling', () => {
    const next = { ...base, input: ['x', 'y', 'z'], max_output_tokens: 10 }
    const cmp = compareRequestPrefix({ ...base, max_output_tokens: 99 }, next)
    assert.equal(cmp.divergence, null)
    assert.equal(cmp.sharedInputChars, cmp.previousInputChars)
  })

  it('names the first changed input item and the shared length before it', () => {
    const cmp = compareRequestPrefix(base, { ...base, input: ['x', 'Y', 'z'] })
    assert.ok(cmp.divergence)
    assert.equal(cmp.divergence.field, 'input')
    assert.equal(cmp.divergence.index, 1)
    assert.equal(cmp.sharedInputChars, JSON.stringify(['x']).length)
    assert.match(describeDivergence(cmp.divergence), /^input\[1\] changed/)
  })

  it('treats a shortened input as divergence at the first missing item', () => {
    assert.equal(compareRequestPrefix(base, { ...base, input: ['x'] }).divergence?.index, 1)
  })

  it('reports tool order and other request fields', () => {
    const reordered = { ...base, tools: [...base.tools].reverse() }
    assert.equal(compareRequestPrefix(base, reordered).divergence?.field, 'tools')
    assert.equal(
      compareRequestPrefix(base, { ...base, prompt_cache_key: 'k' }).divergence?.field,
      'prompt_cache_key',
    )
  })
})
