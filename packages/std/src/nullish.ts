/**
 * Presence predicates for dropping `null` / `undefined` from a collection.
 *
 * The idiom these replace is an inline type predicate:
 *
 * ```ts
 * items.map(parse).filter((item): item is Parsed => item !== null)
 * ```
 *
 * TypeScript never checks that `item is Parsed` follows from the body, so the
 * annotation and the condition can drift apart silently, and an anonymous
 * predicate cannot be tested. These named equivalents are checked once, here,
 * and read the same at every call site: `.filter(isNonNull)`.
 */

/** True for every value except `undefined` — `null` is a value, and passes. */
export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

/** True for every value except `null` — `undefined` is not filtered out. */
export function isNonNull<T>(value: T | null): value is T {
  return value !== null
}
