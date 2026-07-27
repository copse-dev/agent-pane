import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRecord, optionalBoolean, optionalRecord, optionalString } from './unknown-value.mts'

describe('unknown value helpers', () => {
  it('treats null and undefined as absent optional values', () => {
    for (const value of [null, undefined]) {
      assert.equal(optionalString(value), undefined)
      assert.equal(optionalBoolean(value), undefined)
      assert.equal(optionalRecord(value), undefined)
    }
  })

  it('distinguishes plain records from arrays', () => {
    assert.equal(isRecord({ key: 'value' }), true)
    assert.equal(isRecord([]), false)
  })
})
