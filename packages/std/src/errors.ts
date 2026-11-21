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

/**
 * An `AggregateError` whose message names each cause. Errors crossing IPC keep
 * only their message, so a bare summary would hide why the operation failed.
 */
export function aggregateFailure(failures: readonly unknown[], summary: string): AggregateError {
  const causes = failures.map((failure) => {
    const message = errorMessage(failure).replace(/\s+/g, ' ').trim()
    return message.length > 300 ? message.slice(0, 299) + '…' : message
  })
  return new AggregateError(failures, summary + ': ' + causes.join('; '))
}
