import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  forceKillWedgedE2eSession,
  isAfterTestBudgetTimeout,
  isDeadSessionError,
  isDeleteSessionBudgetTimeout,
  isIgnorableAfterTestError,
  isIgnorableDeleteSessionError,
  isMochaTimeoutError,
  installDeleteSessionSafety,
  sessionPidsFromCapabilities,
  shouldSkipAfterTestSessionTraffic,
  withTimeout,
} from '../tests/e2e/helpers/after-test-safety.ts'

describe('isMochaTimeoutError', () => {
  it('matches Mocha timeout messages', () => {
    assert.equal(
      isMochaTimeoutError(new Error('Timeout of 60000ms exceeded. The execution in the test…')),
      true,
    )
    assert.equal(isMochaTimeoutError(new Error('timeout of 90000ms exceeded')), true)
  })

  it('rejects unrelated errors and non-errors', () => {
    assert.equal(isMochaTimeoutError(new Error('Unexpected error toast(s): boom')), false)
    assert.equal(isMochaTimeoutError(null), false)
    assert.equal(isMochaTimeoutError(undefined), false)
    assert.equal(isMochaTimeoutError('Timeout of 60000ms exceeded'), false)
  })
})

describe('isDeadSessionError', () => {
  it('matches WebDriver / undici transport deaths', () => {
    assert.equal(
      isDeadSessionError(
        new Error('WebDriverError: Request failed with error code UND_ERR_HEADERS_TIMEOUT'),
      ),
      true,
    )
    assert.equal(
      isDeadSessionError(
        new Error('The operation was aborted due to timeout when running "execute/sync"'),
      ),
      true,
    )
    assert.equal(
      isDeadSessionError(new Error('Timed out receiving message from renderer: 30.000')),
      true,
    )
    assert.equal(isDeadSessionError(new Error('no such session')), true)
  })

  it('rejects real assertion failures', () => {
    assert.equal(isDeadSessionError(new Error('Unexpected error toast(s): boom')), false)
    assert.equal(isDeadSessionError(new Error('expected true to equal false')), false)
  })
})

describe('shouldSkipAfterTestSessionTraffic', () => {
  it('skips on mocha timeout or dead session', () => {
    assert.equal(shouldSkipAfterTestSessionTraffic(new Error('Timeout of 60000ms exceeded')), true)
    assert.equal(
      shouldSkipAfterTestSessionTraffic(new Error('UND_ERR_HEADERS_TIMEOUT when running element')),
      true,
    )
    assert.equal(
      shouldSkipAfterTestSessionTraffic(new Error('Unexpected error toast(s): boom')),
      false,
    )
  })
})

describe('isIgnorableAfterTestError', () => {
  it('ignores budget / dead-session but not real toast failures', () => {
    assert.equal(
      isIgnorableAfterTestError(new Error('afterTest toast assertion timed out after 5000ms')),
      true,
    )
    assert.equal(
      isAfterTestBudgetTimeout(new Error('afterTest failure artifacts timed out after 5000ms')),
      true,
    )
    assert.equal(isIgnorableAfterTestError(new Error('Unexpected error toast(s): boom')), false)
  })
})

describe('isIgnorableDeleteSessionError', () => {
  it('ignores deleteSession budget and transport deaths', () => {
    assert.equal(
      isDeleteSessionBudgetTimeout(new Error('deleteSession timed out after 5000ms')),
      true,
    )
    assert.equal(
      isIgnorableDeleteSessionError(new Error('deleteSession timed out after 5000ms')),
      true,
    )
    assert.equal(
      isIgnorableDeleteSessionError(
        new Error('WebDriverError: The operation was aborted due to timeout when running DELETE'),
      ),
      true,
    )
    assert.equal(isIgnorableDeleteSessionError(new Error('Unexpected error toast(s): boom')), false)
  })
})

describe('withTimeout', () => {
  it('resolves when the promise wins', async () => {
    await assert.doesNotReject(withTimeout(Promise.resolve('ok'), 1_000, 'fast'))
    assert.equal(await withTimeout(Promise.resolve(7), 1_000, 'fast'), 7)
  })

  it('rejects when the timer wins', async () => {
    await assert.rejects(
      withTimeout(new Promise(() => undefined), 20, 'slow op'),
      /slow op timed out after 20ms/,
    )
  })
})

describe('installDeleteSessionSafety', () => {
  it('returns normally when deleteSession succeeds', async () => {
    const session = {
      deleteSession: async (): Promise<string> => 'ok',
    }
    installDeleteSessionSafety(session, { budgetMs: 1_000, kill: () => undefined })
    assert.equal(await session.deleteSession(), 'ok')
  })

  it('kills and swallows a hung deleteSession', async () => {
    let killed = 0
    const session = {
      deleteSession: async (): Promise<string> => new Promise<string>(() => undefined),
    }
    installDeleteSessionSafety(session, {
      budgetMs: 30,
      kill: () => {
        killed += 1
      },
    })
    assert.equal(await session.deleteSession(), undefined)
    assert.equal(killed, 1)
  })

  it('kills and swallows a dead-session deleteSession error', async () => {
    let killed = 0
    const session = {
      deleteSession: async (): Promise<string> => {
        throw new Error('WebDriverError: no such session')
      },
    }
    installDeleteSessionSafety(session, {
      budgetMs: 1_000,
      kill: () => {
        killed += 1
      },
    })
    assert.equal(await session.deleteSession(), undefined)
    assert.equal(killed, 1)
  })

  it('is idempotent (does not wrap twice)', async () => {
    let calls = 0
    const session = {
      deleteSession: async (): Promise<string> => {
        calls += 1
        return 'ok'
      },
    }
    installDeleteSessionSafety(session, { budgetMs: 1_000, kill: () => undefined })
    installDeleteSessionSafety(session, { budgetMs: 1_000, kill: () => undefined })
    await session.deleteSession()
    assert.equal(calls, 1)
  })

  it('uses overwriteCommand when present (WDIO / @wdio/globals path)', async () => {
    let killed = 0
    let overwriteCalls = 0
    let activeDelete: ((options?: unknown) => Promise<unknown>) | undefined

    const session = {
      deleteSession: async (): Promise<string> => {
        throw new Error('raw deleteSession must not be called after overwriteCommand')
      },
      overwriteCommand(
        name: string,
        fn: (
          this: unknown,
          origCommand: (...args: unknown[]) => unknown,
          ...args: unknown[]
        ) => unknown,
      ): void {
        assert.equal(name, 'deleteSession')
        overwriteCalls += 1
        const orig = async (): Promise<string> => {
          throw new Error(
            'WebDriverError: Request failed with error code ECONNREFUSED when running DELETE',
          )
        }
        activeDelete = async (options?: unknown): Promise<unknown> =>
          await fn.call(session, orig, options)
      },
    }

    installDeleteSessionSafety(session, {
      budgetMs: 1_000,
      kill: () => {
        killed += 1
      },
    })
    // Second install must not register another overwriteCommand.
    installDeleteSessionSafety(session, { budgetMs: 1_000, kill: () => undefined })

    assert.equal(overwriteCalls, 1)
    assert.ok(activeDelete)
    assert.equal(await activeDelete(), undefined)
    assert.equal(killed, 1)
  })
})

describe('sessionPidsFromCapabilities', () => {
  it('reads the driver and browser pids WDIO and chromedriver report', () => {
    assert.deepEqual(
      sessionPidsFromCapabilities({ 'wdio:driverPID': 4321, 'goog:processID': 8765 }),
      { driverPid: 4321, browserPid: 8765 },
    )
  })

  it('returns nothing for capabilities that carry no pids', () => {
    assert.deepEqual(sessionPidsFromCapabilities({ browserName: 'chrome' }), {})
    assert.deepEqual(sessionPidsFromCapabilities(null), {})
    assert.deepEqual(sessionPidsFromCapabilities(undefined), {})
    assert.deepEqual(sessionPidsFromCapabilities('nope'), {})
  })

  // 0 and negatives mean "signal a whole process group" to process.kill, and 1
  // is init — exactly the blast radius the scoping exists to prevent.
  it('rejects pids that would widen the blast radius', () => {
    for (const pid of [0, -1, -4321, 1, 1.5, Number.NaN, '4321', null]) {
      assert.deepEqual(
        sessionPidsFromCapabilities({ 'wdio:driverPID': pid, 'goog:processID': pid }),
        {},
        `pid ${String(pid)} must be rejected`,
      )
    }
  })

  it('refuses to target the test runner itself', () => {
    assert.deepEqual(sessionPidsFromCapabilities({ 'wdio:driverPID': process.pid }), {})
  })
})

describe('forceKillWedgedE2eSession', () => {
  /** A harmless child that stays alive until signalled. */
  function spawnSleeper(): { pid: number; child: ReturnType<typeof spawn> } {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], {
      stdio: 'ignore',
    })
    assert.ok(child.pid, 'sleeper failed to spawn')
    return { pid: child.pid, child }
  }

  /** ESRCH from signal 0 means the process is gone. */
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // The regression this whole change exists for: worker N's kill must not reap
  // the driver worker N+1 just spawned (run 31204691492 — one wedge, 21 dead
  // drivers, every shard 0-2 passed / 19-21 failed).
  it('kills only the session it is given, leaving another worker alive', async () => {
    const mine = spawnSleeper()
    const theirs = spawnSleeper()
    try {
      const exited = new Promise((resolve) => mine.child.once('exit', resolve))
      forceKillWedgedE2eSession({ driverPid: mine.pid })
      await exited
      assert.equal(isAlive(theirs.pid), true, "another worker's driver was killed")
    } finally {
      theirs.child.kill('SIGKILL')
    }
  })

  it('kills both the driver and the browser of its own session', async () => {
    const driver = spawnSleeper()
    const browser = spawnSleeper()
    const bothExited = Promise.all([
      new Promise((resolve) => driver.child.once('exit', resolve)),
      new Promise((resolve) => browser.child.once('exit', resolve)),
    ])
    forceKillWedgedE2eSession({ driverPid: driver.pid, browserPid: browser.pid })
    await bothExited
  })

  // Without pids we cannot tell our processes from anyone else's, so the only
  // safe move is to do nothing — one slow teardown beats a host-wide sweep.
  it('kills nothing when it cannot identify the session', async () => {
    const bystander = spawnSleeper()
    try {
      forceKillWedgedE2eSession()
      forceKillWedgedE2eSession({})
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(isAlive(bystander.pid), true)
    } finally {
      bystander.child.kill('SIGKILL')
    }
  })

  it('is silent when the pid has already exited', () => {
    const gone = spawnSleeper()
    gone.child.kill('SIGKILL')
    assert.doesNotThrow(() => {
      forceKillWedgedE2eSession({ driverPid: gone.pid, browserPid: gone.pid })
    })
  })
})
