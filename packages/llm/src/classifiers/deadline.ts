import { ClassifierError } from './error.ts'

export interface ClassifierDeadline {
  /** Aborts with a `timeout` or `cancelled` ClassifierError as its reason. */
  signal: AbortSignal
  /** Rejects with the same reason, for racing work that may ignore `signal`. */
  interrupted: Promise<never>
  /** Stop the timer and detach from the caller's signal. */
  dispose(): void
}

/**
 * One deadline for a whole adapter call. The reason is always a
 * ClassifierError, so callers can rethrow it without mapping DOM abort
 * reasons. The timer is deliberately referenced: an eval process waiting only
 * on a stalled endpoint must still reach its deadline.
 */
export function classifierDeadline(timeoutMs: number, caller?: AbortSignal): ClassifierDeadline {
  const controller = new AbortController()
  const cancel = (): void => {
    controller.abort(new ClassifierError('cancelled', 'Classifier call cancelled.'))
  }
  const timer = setTimeout(() => {
    controller.abort(new ClassifierError('timeout', 'Classifier call timed out.'))
  }, timeoutMs)
  caller?.addEventListener('abort', cancel, { once: true })
  if (caller?.aborted) cancel()
  const interrupted = new Promise<never>((_, reject) => {
    const rejectWithReason = (): void => {
      reject(interruption(controller.signal))
    }
    if (controller.signal.aborted) rejectWithReason()
    else controller.signal.addEventListener('abort', rejectWithReason, { once: true })
  })
  // Only a caller that races it observes the rejection.
  interrupted.catch(() => undefined)
  return {
    signal: controller.signal,
    interrupted,
    dispose(): void {
      clearTimeout(timer)
      caller?.removeEventListener('abort', cancel)
    },
  }
}

/** The ClassifierError an aborted deadline signal carries. */
export function interruption(signal: AbortSignal): ClassifierError {
  const reason: unknown = signal.reason
  return reason instanceof ClassifierError
    ? reason
    : new ClassifierError('cancelled', 'Classifier call cancelled.')
}
