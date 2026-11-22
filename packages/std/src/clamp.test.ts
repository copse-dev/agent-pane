import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clamp } from './clamp.ts'

describe('clamp', () => {
  it('returns a value already inside the range unchanged', () => {
    assert.equal(clamp(5, 0, 10), 5)
    assert.equal(clamp(0, 0, 10), 0)
    assert.equal(clamp(10, 0, 10), 10)
  })

  it('raises a value below the range to min and lowers one above it to max', () => {
    assert.equal(clamp(-3, 0, 10), 0)
    assert.equal(clamp(42, 0, 10), 10)
    assert.equal(clamp(-Infinity, -1, 1), -1)
    assert.equal(clamp(Infinity, -1, 1), 1)
  })

  it('lets the upper bound win when max < min, like the inline form it replaces', () => {
    assert.equal(clamp(5, 10, 0), 0)
    assert.equal(clamp(-5, 10, 0), 0)
  })

  it('passes NaN through', () => {
    assert.ok(Number.isNaN(clamp(Number.NaN, 0, 1)))
  })
})
