// Package-internal utilities, vendored so `@copse/agent` depends on nothing from
// the host app. These are verbatim copies of the app's `@shared/array-utils.ts`
// and `@shared/errors.ts` helpers — small, stable primitives the module needs.

/**
 * Return the element at `index`, throwing if the array has no element there.
 *
 * Lets call sites read a known-present element without a non-null assertion
 * while staying honest under `noUncheckedIndexedAccess` (which types `arr[i]`
 * as `T | undefined`). Prefer this over `arr[i]!` for elements a preceding
 * length check guarantees exist.
 */
export function at<T>(array: readonly T[], index: number): T {
  const value = array[index]
  if (value === undefined) {
    throw new Error(`expected an array element at index ${String(index)}`)
  }
  return value
}

/**
 * Extract a human-readable message from an unknown caught value.
 *
 * `catch` binds `unknown`, so `(err as Error).message` is an unsafe assertion —
 * a thrown string, number, or plain object is not an `Error` and has no
 * `.message`. This narrows safely: an `Error`'s `message`, otherwise the value
 * coerced to a string.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
