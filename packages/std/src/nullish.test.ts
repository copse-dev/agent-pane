import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isDefined, isNonBlankString, isNonEmptyString, isNonNull } from './nullish.ts'

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

/**
 * Non-string values the two string predicates must reject. Kept separate from
 * PRESENT_VALUES because the interesting axis here is "looks stringy but is
 * not" rather than "is absent".
 */
const NON_STRINGS: unknown[] = [
  undefined,
  null,
  0,
  1,
  Number.NaN,
  true,
  false,
  {},
  [],
  ['a'],
  { toString: (): string => 'a' },
  new String('a'),
  (): string => 'a',
  Symbol('a'),
  1n,
  new Date(0),
]

/** Strings that are empty, or contain nothing but whitespace. */
const BLANK_STRINGS = ['', ' ', '  ', '\t', '\n', '\r\n', ' \t\n ', '\u00a0', '\u2003']

describe('isNonEmptyString', () => {
  it('accepts any string with at least one character, whitespace included', () => {
    for (const value of ['a', ' ', '\t', '0', 'false', '  x  ', '\u00a0']) {
      assert.equal(isNonEmptyString(value), true, `rejected ${JSON.stringify(value)}`)
    }
  })

  it('rejects the empty string', () => {
    assert.equal(isNonEmptyString(''), false)
  })

  it('rejects every non-string', () => {
    for (const value of NON_STRINGS) {
      assert.equal(isNonEmptyString(value), false, `accepted ${String(value)}`)
    }
  })

  it('agrees with the Boolean() filter it replaces', () => {
    // The call sites this was extracted from were `.filter((p): p is string =>
    // Boolean(p))` over `(string | null | undefined)[]`. Over that element type
    // the two are the same function, which is what makes the swap safe.
    const values: (string | null | undefined)[] = ['a', '', ' ', null, undefined, '0']
    assert.deepEqual(
      values.filter(isNonEmptyString),
      values.filter((value) => Boolean(value)),
    )
  })

  it('narrows an array element type', () => {
    const values: (string | null | undefined)[] = ['a', '', null, 'b', undefined]
    const present: string[] = values.filter(isNonEmptyString)
    assert.deepEqual(present, ['a', 'b'])
  })
})

describe('isNonBlankString', () => {
  it('accepts a string with at least one non-whitespace character', () => {
    for (const value of ['a', '0', 'false', '  x  ', 'x\n']) {
      assert.equal(isNonBlankString(value), true, `rejected ${JSON.stringify(value)}`)
    }
  })

  it('rejects empty and whitespace-only strings', () => {
    for (const value of BLANK_STRINGS) {
      assert.equal(isNonBlankString(value), false, `accepted ${JSON.stringify(value)}`)
    }
  })

  it('rejects every non-string', () => {
    for (const value of NON_STRINGS) {
      assert.equal(isNonBlankString(value), false, `accepted ${String(value)}`)
    }
  })

  it('is strictly stronger than isNonEmptyString', () => {
    // The one-line statement of why both exist. Every blank string separates
    // them; nothing separates them the other way.
    for (const value of BLANK_STRINGS) {
      if (value.length === 0) continue
      assert.equal(isNonEmptyString(value), true, `${JSON.stringify(value)} should be non-empty`)
      assert.equal(isNonBlankString(value), false, `${JSON.stringify(value)} should be blank`)
    }
  })

  it('narrows an array element type', () => {
    const values: (string | undefined)[] = ['a', '  ', undefined, 'b']
    const present: string[] = values.filter(isNonBlankString)
    assert.deepEqual(present, ['a', 'b'])
  })
})
