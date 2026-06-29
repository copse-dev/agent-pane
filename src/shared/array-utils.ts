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
