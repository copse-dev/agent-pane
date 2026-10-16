import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toIsoTimestamp } from './internal-utils.ts'

describe('toIsoTimestamp', () => {
  it('reads unix seconds, unix milliseconds and ISO strings', () => {
    const cases: Array<[unknown, string | null]> = [
      [1_700_000_000, '2023-11-14T22:13:20.000Z'],
      [1_700_000_000_000, '2023-11-14T22:13:20.000Z'],
      ['1700000000', '2023-11-14T22:13:20.000Z'],
      ['2023-11-14T22:13:20Z', '2023-11-14T22:13:20.000Z'],
      ['not a date', null],
      [Number.NaN, null],
    ]
    for (const [value, expected] of cases)
      assert.equal(toIsoTimestamp(value, 0), expected, String(value))
  })

  it('returns null instead of throwing for a timestamp past the Date range', () => {
    for (const value of ['99999999999999999', '1'.repeat(30), 9e15, 1e300, -9e15]) {
      assert.equal(toIsoTimestamp(value, 0), null, String(value))
    }
  })
})
