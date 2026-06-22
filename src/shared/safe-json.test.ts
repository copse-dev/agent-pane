import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeJsonParse } from './safe-json.ts'

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 })
    assert.deepEqual(safeJsonParse('[1,2,3]'), [1, 2, 3])
  })

  it('returns null on invalid JSON instead of throwing', () => {
    assert.equal(safeJsonParse('not json'), null)
    assert.equal(safeJsonParse(''), null)
    assert.equal(safeJsonParse('{unterminated'), null)
  })

  it('parses the JSON literal null as null', () => {
    assert.equal(safeJsonParse('null'), null)
  })
})
