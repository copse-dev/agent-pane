import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ANONYMOUS, assertedPredicatesIn } from './type-predicates.mts'

/**
 * The asserted/checked split is the whole content of the inventory: a shape
 * wrongly called "checked" drops silently out of the ratchet in
 * `scripts/type-predicate-inventory.test.ts`, which is the one failure the
 * ratchet cannot report on itself.
 *
 * The four `does not count` cases are each excluded for a different reason,
 * and only the first is the compiler's doing:
 *
 *   - the annotated binding is checked by `tsc` — a `return true` initialiser
 *     is TS2677, "Signature … must be a type predicate";
 *   - a `memberOf(TUPLE)` call carries no assertion of its own: the single one
 *     it is built from lives in `@copse/std` and is property-tested there;
 *   - a bodiless signature has nothing at that site to take on trust;
 *   - an unannotated arrow has no claim at all — the compiler derived it.
 */

function names(source: string): string[] {
  return assertedPredicatesIn('probe.ts', source).map((predicate) => predicate.name)
}

describe('assertedPredicatesIn', () => {
  it('counts a function declaration that annotates its own return', () => {
    assert.deepEqual(
      names(`export function isFoo(v: unknown): v is string { return typeof v === 'string' }`),
      ['isFoo'],
    )
  })

  it('counts a method and a function expression', () => {
    assert.deepEqual(
      names(`
        class Parser { isFoo(v: unknown): v is string { return typeof v === 'string' } }
        const bar = function isBar(v: unknown): v is string { return typeof v === 'string' }
      `),
      ['isFoo', 'isBar'],
    )
  })

  it('counts an annotated arrow, and names it after the binding it lands in', () => {
    // The predicate is on the arrow rather than on the binding, so nothing
    // checks the body: this is the asserted form written with `=>`.
    assert.deepEqual(names(`const isFoo = (v: unknown): v is string => typeof v === 'string'`), [
      'isFoo',
    ])
  })

  it('counts an inline predicate as anonymous', () => {
    assert.deepEqual(names(`const out = xs.filter((x): x is string => typeof x === 'string')`), [
      ANONYMOUS,
    ])
  })

  it('counts an `asserts` predicate, and marks it as one', () => {
    const found = assertedPredicatesIn(
      'probe.ts',
      `function assertFoo(v: unknown): asserts v is string { if (typeof v !== 'string') throw new Error('no') }`,
    )
    assert.deepEqual(
      found.map((predicate) => [predicate.name, predicate.asserts]),
      [['assertFoo', true]],
    )
  })

  it('does not count the annotated-binding form — tsc checks the initialiser', () => {
    assert.deepEqual(
      names(`const isFoo: (v: unknown) => v is string = (v) => typeof v === 'string'`),
      [],
    )
  })

  it('does not count a factory call — the assertion lives inside the factory', () => {
    assert.deepEqual(names(`export const isTheme = memberOf(THEMES)`), [])
  })

  it('does not count a signature with no body', () => {
    // An interface, an overload and a `.d.ts` declaration have no body to lie
    // in; whatever implements them is checked, and gets counted at its own site
    // if it annotates.
    assert.deepEqual(
      names(`
        interface Guard { isFoo(v: unknown): v is string }
        type Fn = (v: unknown) => v is string
        declare function isBar(v: unknown): v is string
      `),
      [],
    )
  })

  it('does not count an inferred predicate — there is no annotation to audit', () => {
    assert.deepEqual(names(`const out = xs.filter((x) => typeof x === 'string')`), [])
  })

  it('reports the predicate line, not the declaration line', () => {
    const found = assertedPredicatesIn(
      'probe.ts',
      [
        'function isFoo(',
        '  v: unknown,',
        '): v is string {',
        "  return typeof v === 'string'",
        '}',
      ].join('\n'),
    )
    assert.deepEqual(
      found.map((predicate) => predicate.line),
      [3],
    )
  })
})
