import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isDefined, isNonNull } from './nullish.ts'

// Everything a "is this absent?" check could plausibly be asked about. The
// falsy members are the ones a `!value` shortcut would wrongly reject, and the
// prototype-shaped members are the ones an object lookup would wrongly accept.
const PRESENT_VALUES: unknown[] = [
  0,
  -0,
  Number.NaN,
  '',
  '0',
  false,
  [],
  {},
  Object.create(null),
  (): undefined => undefined,
  new Date(0),
  new Error('x'),
  Symbol('s'),
  0n,
  '__proto__',
  { __proto__: null, constructor: 'x', toString: 'y' },
]

describe('isDefined', () => {
  it('rejects undefined and nothing else', () => {
    assert.equal(isDefined(undefined), false)
    assert.equal(isDefined(null), true)
    for (const [index, value] of PRESENT_VALUES.entries()) {
      assert.equal(isDefined(value), true, `rejected PRESENT_VALUES[${String(index)}]`)
    }
  })

  it('narrows an array element type', () => {
    const values: (string | undefined)[] = ['a', undefined, 'b']
    const defined: string[] = values.filter(isDefined)
    assert.deepEqual(defined, ['a', 'b'])
  })

  it('keeps null when it is part of the element type', () => {
    const values: (string | null | undefined)[] = ['a', null, undefined]
    const defined: (string | null)[] = values.filter(isDefined)
    assert.deepEqual(defined, ['a', null])
  })
})

describe('isNonNull', () => {
  it('rejects null and nothing else', () => {
    assert.equal(isNonNull(null), false)
    assert.equal(isNonNull(undefined), true)
    for (const [index, value] of PRESENT_VALUES.entries()) {
      assert.equal(isNonNull(value), true, `rejected PRESENT_VALUES[${String(index)}]`)
    }
  })

  it('narrows an array element type', () => {
    const values: (number | null)[] = [1, null, 2]
    const nonNull: number[] = values.filter(isNonNull)
    assert.deepEqual(nonNull, [1, 2])
  })

  it('keeps undefined when it is part of the element type', () => {
    const values: (number | null | undefined)[] = [1, null, undefined]
    const nonNull: (number | undefined)[] = values.filter(isNonNull)
    assert.deepEqual(nonNull, [1, undefined])
  })
})
