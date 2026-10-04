/** Search in order, awaiting each predicate instead of treating its Promise as truthy. */
export async function findAsync<T>(
  values: Iterable<T>,
  predicate: (value: T) => Promise<boolean>,
): Promise<T | undefined> {
  for (const value of values) {
    if (await predicate(value)) return value
  }
  return undefined
}
