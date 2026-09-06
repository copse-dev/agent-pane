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

/**
 * True for a string with at least one character. `' '` passes.
 *
 * Equivalent to the `Boolean(value)` filter that call sites reach for when the
 * array is `(string | null | undefined)[]`, but it says what it means and it
 * narrows — `Boolean(v)` infers no predicate at all, so a `.filter(Boolean)`
 * silently keeps `string | undefined` as the element type.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * True for a string with at least one non-whitespace character. `' '` fails.
 *
 * The distinction from {@link isNonEmptyString} is the whole reason both exist:
 * a config field spelled `"  "` is a user mistake that should be rejected, and
 * a rendered CSS class of `' '` is merely useless. Picking the wrong one is a
 * silent behaviour change, so neither is the "default" — read the call site and
 * choose.
 */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
