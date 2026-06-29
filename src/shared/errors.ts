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
