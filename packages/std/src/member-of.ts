/**
 * Build a membership type predicate from the list that defines the type.
 *
 * A hand-written membership predicate is an unchecked assertion twice over.
 * TypeScript never verifies that a `value is T` body proves its claim, and
 * `.includes()` / `.some()` / `.has()` do not narrow — so the compiler cannot
 * derive the predicate from the body either (see `docs/type-safety.md`). That
 * leaves the annotation and the list free to drift apart silently:
 *
 * ```ts
 * // Compiles. Rejects every value the type says is valid.
 * function isTheme(value: unknown): value is Theme {
 *   return typeof value === 'string' && OTHER_LIST.includes(value)
 * }
 * ```
 *
 * `memberOf` makes the tuple the only source of truth. There is exactly one
 * `is` assertion — the one below — and it is property-tested in
 * `member-of.test.ts`, so every predicate built from it is correct by
 * construction rather than by review.
 *
 * ```ts
 * export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
 * export type ThemePreference = (typeof THEME_PREFERENCES)[number]
 * export const isThemePreference = memberOf(THEME_PREFERENCES)
 * ```
 *
 * Pass a tuple whose element type is the union you want. A `readonly string[]`
 * yields `value is string`, which is useless but not unsound — annotate the
 * binding (`const isTheme: (v: unknown) => v is ThemePreference = memberOf(…)`)
 * when you want the compiler to reject that.
 *
 * Membership uses `Set` semantics (SameValueZero), so `NaN` matches `NaN` and
 * `-0` matches `0`. That only matters for numeric member lists.
 */
export function memberOf<const T extends readonly (string | number | boolean)[]>(
  members: T,
): (value: unknown) => value is T[number] {
  const set = new Set<unknown>(members)
  return (value): value is T[number] => set.has(value)
}

/**
 * Build a key predicate from the record whose keys define the type.
 *
 * The sibling of {@link memberOf} for the case where the vocabulary is a
 * record's keys rather than a tuple's entries. Same reason it exists: `key in
 * RECORD` does not narrow, so the predicate around it is an assertion nothing
 * checks.
 *
 * ```ts
 * const SCHEMAS = { model: …, appIconVariant: … } as const satisfies Record<string, ZodType>
 * export const isWritableSettingKey = keyOf(SCHEMAS)
 * ```
 *
 * It uses `Object.hasOwn`, **not** `in`, and that is the point rather than a
 * detail. `in` walks the prototype chain, so a predicate written with it
 * accepts `toString`, `constructor`, `valueOf`, `hasOwnProperty`, `__proto__`,
 * `isPrototypeOf`, `propertyIsEnumerable` and `toLocaleString` — eight keys no
 * record literal actually declares. A gate built on `in` therefore answers
 * "yes, that key is allowed" for all eight, and whatever runs next reads an
 * inherited function instead of the value it expected.
 *
 * A record with a `null` prototype avoids that too, but only if every future
 * declaration remembers to use one. This does not depend on remembering.
 */
export function keyOf<T extends object>(source: T): (value: PropertyKey) => value is keyof T {
  return (value): value is keyof T => Object.hasOwn(source, value)
}
