import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isAfterTestBudgetTimeout,
  isDeadSessionError,
  isDeleteSessionBudgetTimeout,
  isIgnorableAfterTestError,
  isIgnorableDeleteSessionError,
  isMochaTimeoutError,
  installDeleteSessionSafety,
  shouldSkipAfterTestSessionTraffic,
  wedgedSessionPatternsForTest,
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

// The e2e outage of 2026-08-07 (run 31161544796 shard 6: `0 passed, 21 failed`)
// came from this module, not from the runner pool. `pkill -f` is unscoped, so
// killing "chromedriver" took down the driver this worker was about to reuse —
// and `browser.reloadSession()`, which nearly every spec calls in `before all`,
// is a deleteSession *followed by* a newSession on that same driver. One flaky
// teardown therefore poisoned every remaining spec on the shard.
describe('wedged-session kill scope', () => {
  it('never names chromedriver, whose survival the next session depends on', () => {
    const patterns = wedgedSessionPatternsForTest()
    assert.ok(
      patterns.every((pattern) => !/chromedriver/i.test(pattern)),
      'killing chromedriver mid-run breaks the newSession half of reloadSession',
    )
    assert.ok(
      patterns.some((pattern) => /electron/i.test(pattern)),
      'Electron is what actually wedges, and is still worth killing',
    )
  })

  it('treats a socket death on deleteSession as ignorable rather than fatal', () => {
    // The exact shape observed in run 31175526565 shard 3's wdio.log.
    const error = new Error(
      'WebDriverError: Request failed with error code UND_ERR_SOCKET when running ' +
        '"http://localhost:41083/session/ccafb19078f86ad8408b410656525abc" with method "DELETE"',
    )
    assert.equal(isDeadSessionError(error), true)
    assert.equal(isIgnorableDeleteSessionError(error), true)
  })
})
