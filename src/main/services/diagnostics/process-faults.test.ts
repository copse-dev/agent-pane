import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatProcessFault,
  installProcessFaultHandlers,
  reportProcessFault,
  resetProcessFaultHandlersForTest,
} from './process-faults.ts'

afterEach(() => {
  resetProcessFaultHandlersForTest()
})

describe('formatProcessFault', () => {
  it('uses the stack when the fault is an Error', () => {
    const err = new Error('watch ENOENT')
    const text = formatProcessFault('uncaughtException', err)
    assert.match(text, /^\[process\] uncaughtException — /)
    assert.match(text, /watch ENOENT/)
  })

  it('stringifies a non-Error rejection', () => {
    assert.equal(
      formatProcessFault('unhandledRejection', 'socket hang up'),
      '[process] unhandledRejection — socket hang up',
    )
  })
})

describe('reportProcessFault', () => {
  it('logs an unhandled rejection without quitting', () => {
    const logs: string[] = []
    const quits: unknown[] = []
    reportProcessFault('unhandledRejection', 'late promise', {
      log: (message) => {
        logs.push(message)
      },
      onUncaughtException: (err) => {
        quits.push(err)
      },
    })
    assert.equal(logs.length, 1)
    assert.match(logs[0] ?? '', /unhandledRejection/)
    assert.deepEqual(quits, [])
  })

  it('logs an uncaught exception and asks the app to quit', () => {
    const logs: string[] = []
    const quits: unknown[] = []
    const err = new Error('FSWatcher error')
    reportProcessFault('uncaughtException', err, {
      log: (message) => {
        logs.push(message)
      },
      onUncaughtException: (fault) => {
        quits.push(fault)
      },
    })
    assert.equal(logs.length, 1)
    assert.match(logs[0] ?? '', /uncaughtException/)
    assert.deepEqual(quits, [err])
  })
})

describe('installProcessFaultHandlers', () => {
  it('is idempotent so boot cannot stack listeners', () => {
    const beforeRejection = process.listenerCount('unhandledRejection')
    const beforeException = process.listenerCount('uncaughtException')
    const first = installProcessFaultHandlers({ log: () => undefined })
    const second = installProcessFaultHandlers({ log: () => undefined })
    try {
      assert.equal(process.listenerCount('unhandledRejection'), beforeRejection + 1)
      assert.equal(process.listenerCount('uncaughtException'), beforeException + 1)
    } finally {
      second()
      first()
    }
    assert.equal(process.listenerCount('unhandledRejection'), beforeRejection)
    assert.equal(process.listenerCount('uncaughtException'), beforeException)
  })
})
