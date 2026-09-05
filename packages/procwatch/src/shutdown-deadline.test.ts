import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DeadlineTimers } from './shutdown-deadline.ts'
import { runWithDeadline } from './shutdown-deadline.ts'

/** A clock the test fires by hand, so no assertion waits on a real timer. */
function manualTimers(): DeadlineTimers & { fire: () => void; pending: () => number } {
  const scheduled = new Set<() => void>()
  return {
    schedule: (fn): (() => void) => {
      scheduled.add(fn)
      return (): void => {
        scheduled.delete(fn)
      }
    },
    fire: (): void => {
      for (const fn of [...scheduled]) fn()
    },
    pending: (): number => scheduled.size,
  }
}

describe('runWithDeadline', () => {
  it('reports completion when the work finishes in time', async () => {
    const timers = manualTimers()
    const outcome = await runWithDeadline(() => Promise.resolve('done'), 10_000, { timers })
    assert.equal(outcome, 'completed')
  })

  it('cancels the deadline timer once the work settles', async () => {
    const timers = manualTimers()
    await runWithDeadline(() => Promise.resolve(), 10_000, { timers })
    assert.equal(timers.pending(), 0, 'a live timer would keep the loop turning')
  })

  it('treats a failed cleanup as finished so the quit still proceeds', async () => {
    const timers = manualTimers()
    const errors: unknown[] = []
    const boom = new Error('mcp shutdown threw')
    const outcome = await runWithDeadline(() => Promise.reject(boom), 10_000, {
      timers,
      onError: (err) => {
        errors.push(err)
      },
    })
    assert.equal(outcome, 'failed')
    assert.deepEqual(errors, [boom])
  })

  it('resolves at the deadline when the work never settles', async () => {
    const timers = manualTimers()
    let timedOut = 0
    const outcome = runWithDeadline(() => new Promise<void>(() => undefined), 10_000, {
      timers,
      onTimeout: () => {
        timedOut++
      },
    })
    timers.fire()
    assert.equal(await outcome, 'timed-out')
    assert.equal(timedOut, 1)
  })

  it('ignores a late rejection from work it already abandoned', async () => {
    const timers = manualTimers()
    let rejectWork: ((err: unknown) => void) | undefined
    const outcome = runWithDeadline(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWork = reject
        }),
      10_000,
      { timers },
    )
    timers.fire()
    assert.equal(await outcome, 'timed-out')

    // The abandoned cleanup finally gives up. Nothing is awaiting it any more,
    // so this must not surface as an unhandled rejection during shutdown.
    rejectWork?.(new Error('too late'))
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('does not run onTimeout when the work already finished', async () => {
    const timers = manualTimers()
    let timedOut = 0
    await runWithDeadline(() => Promise.resolve(), 10_000, {
      timers,
      onTimeout: () => {
        timedOut++
      },
    })
    timers.fire()
    assert.equal(timedOut, 0)
  })
})
