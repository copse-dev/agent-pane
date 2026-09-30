/**
 * Mark the unreachable remainder of a discriminated-union branch.
 *
 * Passing the value makes a newly added union member a compile error. The throw
 * also preserves a useful failure when untrusted runtime data violates the
 * declared union.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled value ${JSON.stringify(value)}`)
}
