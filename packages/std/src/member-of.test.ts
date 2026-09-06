import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { memberOf } from './member-of.ts'

/**
 * `memberOf` holds the codebase's only membership `is` assertion, so every
 * predicate built from it is only as honest as this file. The contract it has
 * to meet is exact rather than approximate:
 *
 *   memberOf(list)(value) === list.includes(value)   for every list and value
 *
 * so the tests below check that equivalence over a cross-product rather than
 * sampling a few literals. `includes` is the oracle precisely because it is
 * what the hand-written predicates used to say — this pins that the factory
 * did not change the meaning of any of them.
 */

/** Values a string-membership predicate must never accept. */
const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  '',
  ' ',
  0,
  1,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  {},
  [],
  ['a'],
  { toString: (): string => 'a' },
  (): string => 'a',
  Symbol('a'),
  10n,
  new Date(),
  // Prototype keys. A predicate backed by an object lookup rather than a list
  // accepts these; a Set does not. This is the case that makes the factory
  // worth having rather than a `Record<string, true>` map.
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'prototype',
]

/** The mistakes that actually happen, derived from a real member. */
function nearMisses(member: string): readonly string[] {
  return [
    member.toUpperCase(),
    ` ${member}`,
    `${member} `,
    `${member}x`,
    member.slice(0, -1),
    `${member}\n`,
  ].filter((value) => value !== member)
}

/**
 * Member lists spanning the shapes real call sites use: one member, several,
 * members that are prefixes of each other, numeric and boolean members, and
 * the empty list (which no call site should have, but which must still not
 * accept anything).
 */
const LISTS: readonly (readonly (string | number | boolean)[])[] = [
  [],
  ['only'],
  ['light', 'dark', 'system'],
  ['a', 'ab', 'abc'],
  ['allow', 'deny', 'ask'],
  ['', 'blank'],
  [0, 1, 2],
  [-1, 0, 1],
  [true, false],
  ['1', 1],
  ['__proto__'],
  ['toString', 'valueOf'],
]

describe('memberOf', () => {
  it('agrees with Array.prototype.includes on every list/value pair', () => {
    const candidates: readonly unknown[] = [
      ...HOSTILE,
      ...LISTS.flat(),
      ...LISTS.flat()
        .filter((member): member is string => typeof member === 'string')
        .flatMap(nearMisses),
    ]
    for (const list of LISTS) {
      const predicate = memberOf(list)
      // Widened rather than cast: `includes` needs to accept an `unknown`
      // candidate, and it uses SameValueZero — the same equality as the `Set`
      // inside the factory — so it is an exact oracle.
      const oracle: readonly unknown[] = list
      for (const value of candidates) {
        assert.equal(
          predicate(value),
          oracle.includes(value),
          `memberOf(${JSON.stringify(list)}) disagreed on ${String(value)}`,
        )
      }
    }
  })

  it('accepts every member of its own list', () => {
    for (const list of LISTS) {
      const predicate = memberOf(list)
      for (const member of list) {
        assert.equal(predicate(member), true, `rejected its own member ${String(member)}`)
      }
    }
  })

  it('rejects hostile values, including prototype keys', () => {
    const predicate = memberOf(['light', 'dark', 'system'])
    for (const value of HOSTILE) {
      assert.equal(predicate(value), false, `accepted ${String(value)}`)
    }
  })

  it('rejects near-misses of its members', () => {
    const members = ['light', 'dark', 'system'] as const
    const predicate = memberOf(members)
    for (const member of members) {
      for (const miss of nearMisses(member)) {
        assert.equal(predicate(miss), false, `accepted near-miss ${JSON.stringify(miss)}`)
      }
    }
  })

  it('accepts nothing when the list is empty', () => {
    const predicate = memberOf([])
    for (const value of [...HOSTILE, 'anything', 0, true]) {
      assert.equal(predicate(value), false)
    }
  })

  it('does not follow the list after construction', () => {
    // The Set is built once. A caller that mutates a non-`readonly` list it
    // handed in does not silently change what the predicate accepts — worth
    // pinning, because the obvious alternative (`list.includes`) does.
    const mutable = ['first']
    const predicate = memberOf(mutable)
    mutable.push('second')
    assert.equal(predicate('first'), true)
    assert.equal(predicate('second'), false)
  })

  it('uses SameValueZero, so NaN matches itself and -0 matches 0', () => {
    // Documented rather than desirable: it is what `Set` does, and it differs
    // from the `.some((entry) => entry === value)` bodies this replaced, which
    // reject NaN. No current call site has a numeric member list.
    assert.equal(memberOf([Number.NaN])(Number.NaN), true)
    assert.equal(memberOf([0])(-0), true)
  })
})

describe('memberOf narrowing', () => {
  // These assertions are compile-time. They fail the build rather than the
  // suite, which is the point: a `memberOf` that stopped returning a predicate
  // would leave the suite green.
  const THEMES = ['light', 'dark', 'system'] as const
  type Theme = (typeof THEMES)[number]
  const isTheme = memberOf(THEMES)

  it('narrows a filtered array to the member union', () => {
    const mixed: unknown[] = ['light', 'nope', 'dark']
    // Only compiles if `isTheme` is a type predicate over the tuple's union.
    const themes: Theme[] = mixed.filter(isTheme)
    assert.deepEqual(themes, ['light', 'dark'])
  })

  it('narrows in a conditional', () => {
    const value: unknown = 'system'
    if (isTheme(value)) {
      const theme: Theme = value
      assert.equal(theme, 'system')
    } else {
      assert.fail('expected the predicate to accept a member')
    }
  })

  it('satisfies an explicitly annotated predicate binding', () => {
    // The form a call site uses when it wants the compiler to reject a widened
    // member list: a `readonly string[]` would infer `value is string`, which
    // is not assignable to this annotation.
    const annotated: (value: unknown) => value is Theme = memberOf(THEMES)
    assert.equal(annotated('dark'), true)
  })
})
