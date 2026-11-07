export interface ErrorToastSnapshot {
  generation: string
  dom: string[]
  ledger: string[]
  acknowledged: string[]
}

function pendingLedger(snapshot: ErrorToastSnapshot): string[] {
  if (
    snapshot.acknowledged.length > snapshot.ledger.length ||
    snapshot.acknowledged.some((message, index) => snapshot.ledger[index] !== message)
  ) {
    throw new Error('The acknowledged error-toast prefix does not match this document')
  }
  return snapshot.ledger.slice(snapshot.acknowledged.length)
}

/** Visible errors are always checked, including an acknowledged toast not yet dismissed. */
export function unacknowledgedErrorToasts(snapshot: ErrorToastSnapshot): string[] {
  return [...new Set([...snapshot.dom, ...pendingLedger(snapshot)].filter(Boolean))]
}

/** Acknowledge only the exact observed entries; repeated later messages are new errors. */
export function acknowledgedErrorToastPrefix(
  snapshot: ErrorToastSnapshot,
  expected: readonly string[],
): string[] {
  const pending = pendingLedger(snapshot)
  if (
    snapshot.generation === '' ||
    expected.length === 0 ||
    pending.length !== expected.length ||
    pending.some((message, index) => expected[index] !== message) ||
    snapshot.dom.some((message) => !expected.includes(message))
  ) {
    throw new Error('Expected error toasts do not exactly match the observed entries')
  }
  return [...snapshot.ledger]
}

/** A real product error cannot become an ignorable transport error because of its text. */
export class UnexpectedErrorToastsError extends Error {
  constructor(toasts: readonly string[], context?: string) {
    const prefix = context ? `${context}: ` : ''
    super(`${prefix}Unexpected error toast(s): ${toasts.join(' | ')}`)
    this.name = 'UnexpectedErrorToastsError'
  }
}
