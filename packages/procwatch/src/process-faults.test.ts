import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createProcessFaultRouter,
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

describe('createProcessFaultRouter', () => {
  const errWithCode = (code: string): Error & { code: string } =>
    Object.assign(new Error(code), { code })

  it('logs and quits on the first uncaught exception', () => {
    const logs: string[] = []
    const quits: unknown[] = []
    const err = new Error('FSWatcher error')
    const route = createProcessFaultRouter({
      log: (m) => {
        logs.push(m)
      },
      onUncaughtException: (fault) => {
        quits.push(fault)
      },
    })
    route('uncaughtException', err)
    assert.equal(logs.length, 1)
    assert.deepEqual(quits, [err])
  })

  it('starts the quit once, however many faults follow', () => {
    const logs: string[] = []
    let quits = 0
    const route = createProcessFaultRouter({
      log: (m) => {
        logs.push(m)
      },
      onUncaughtException: () => {
        quits++
      },
    })
    for (let i = 0; i < 4; i++) route('uncaughtException', new Error(`boom ${String(i)}`))
    assert.equal(quits, 1, 're-entering before-quit restarts teardown mid-teardown')
    assert.equal(logs.length, 4, 'later faults are still recorded')
  })

  it('never logs a failed write — logging one would write again and fail again', () => {
    const logs: string[] = []
    const route = createProcessFaultRouter({
      log: (m) => {
        logs.push(m)
      },
    })
    route('uncaughtException', errWithCode('EIO'))
    assert.deepEqual(logs, [])
  })

  it('still quits on a write failure even though it cannot say so', () => {
    let quits = 0
    const route = createProcessFaultRouter({
      log: () => undefined,
      onUncaughtException: () => {
        quits++
      },
    })
    route('uncaughtException', errWithCode('EIO'))
    assert.equal(quits, 1)
  })

  it('stops logging once the sink is known dead', () => {
    const logs: string[] = []
    let alive = true
    const route = createProcessFaultRouter({
      log: (m) => {
        logs.push(m)
      },
      isLogSinkAlive: () => alive,
    })
    route('unhandledRejection', new Error('while alive'))
    alive = false
    route('unhandledRejection', new Error('after hangup'))
    assert.equal(logs.length, 1)
    assert.match(logs[0] ?? '', /while alive/)
  })

  it('does not re-enter when logging itself faults synchronously', () => {
    let logCalls = 0
    let route: (kind: 'uncaughtException', fault: unknown) => void = () => undefined
    route = createProcessFaultRouter({
      log: () => {
        logCalls++
        route('uncaughtException', new Error('the log write blew up'))
      },
    })
    route('uncaughtException', new Error('original'))
    assert.equal(logCalls, 1)
  })

  it('terminates instead of livelocking when the terminal has hung up', async () => {
    // The real cycle from issue #1911: each write to the dead pty fails on a
    // later tick, and that failure arrives back as an uncaught exception. The
    // asynchronous gap means no re-entrancy flag can catch it — it is broken
    // only by refusing to log a write failure in the first place.
    const pendingFailures: unknown[] = []
    let writes = 0
    const route = createProcessFaultRouter({
      log: () => {
        writes++
        pendingFailures.push(errWithCode('EIO'))
      },
    })

    route('uncaughtException', new Error('something escaped'))

    let drains = 0
    while (pendingFailures.length > 0 && drains < 100) {
      drains++
      const fault = pendingFailures.shift()
      await Promise.resolve()
      route('uncaughtException', fault)
    }

    assert.equal(writes, 1, 'a write failure must not provoke another write')
    assert.equal(pendingFailures.length, 0, 'the cycle drained instead of growing')
  })
})
