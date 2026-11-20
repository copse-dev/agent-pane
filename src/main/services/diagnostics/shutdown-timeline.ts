/**
 * Quit-timeline logging for issue #4407. DO-NOT-MERGE diagnostic branch.
 *
 * Inert unless `COPSE_E2E=1` or `COPSE_DEBUG_SHUTDOWN=1`: every entry point
 * below returns, or calls straight through, when neither is set, so a normal
 * quit runs exactly the code it ran before.
 *
 * When on, each step of the quit cleanup logs a `[shutdown] step:start` line
 * and a `[shutdown] step:end` line with its duration. A step that never
 * finishes is therefore the last one started, and the deadline handler can name
 * every step still open when it fires. The lines go through `console.log`, like
 * the existing `[shutdown]` lines, so whatever captures those captures these.
 */

type StepOutcome = 'ok' | 'threw' | 'rejected'

function enabled(): boolean {
  return process.env['COPSE_E2E'] === '1' || process.env['COPSE_DEBUG_SHUTDOWN'] === '1'
}

/** Steps that have started and not yet ended, by name, with their start time. */
const openSteps = new Map<string, number>()

function log(message: string): void {
  console.log(`[shutdown] ${message}`)
}

function begin(name: string): number {
  const startedAt = performance.now()
  openSteps.set(name, startedAt)
  log(`step:start ${name}`)
  return startedAt
}

function end(name: string, startedAt: number, outcome: StepOutcome): void {
  openSteps.delete(name)
  log(`step:end ${name} ${(performance.now() - startedAt).toFixed(1)}ms ${outcome}`)
}

/** Log one quit milestone (inert unless enabled). */
export function markShutdown(message: string): void {
  if (!enabled()) return
  log(message)
}

/** Time a synchronous quit step. Adds no await, so ordering is unchanged. */
export function timeShutdownStep(name: string, step: () => void): void {
  if (!enabled()) {
    step()
    return
  }
  const startedAt = begin(name)
  let outcome: StepOutcome = 'threw'
  try {
    step()
    outcome = 'ok'
  } finally {
    end(name, startedAt, outcome)
  }
}

/**
 * Time an asynchronous quit step. Not itself `async`, so a step that throws
 * synchronously still throws synchronously, exactly as the bare call did.
 */
export function timeShutdownStepAsync<T>(name: string, step: () => Promise<T>): Promise<T> {
  if (!enabled()) return step()
  const startedAt = begin(name)
  let pending: Promise<T>
  try {
    pending = step()
  } catch (err) {
    end(name, startedAt, 'threw')
    throw err
  }
  return pending.then(
    (value) => {
      end(name, startedAt, 'ok')
      return value
    },
    (err: unknown) => {
      end(name, startedAt, 'rejected')
      throw err
    },
  )
}

/** Log every step still open, with how long it has been running. */
export function logOpenShutdownSteps(label: string): void {
  if (!enabled()) return
  const now = performance.now()
  const open = [...openSteps].map(
    ([name, startedAt]) => `${name}(${(now - startedAt).toFixed(0)}ms)`,
  )
  log(`${label}: open steps ${open.length === 0 ? 'none' : open.join(', ')}`)
}
