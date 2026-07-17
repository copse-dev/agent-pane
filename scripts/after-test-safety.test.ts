import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isAfterTestBudgetTimeout,
  isDeadSessionError,
  isIgnorableAfterTestError,
  isMochaTimeoutError,
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
    assert.equal(
      shouldSkipAfterTestSessionTraffic(new Error('Timeout of 60000ms exceeded')),
      true,
    )
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
    assert.equal(isAfterTestBudgetTimeout(new Error('afterTest failure artifacts timed out after 5000ms')), true)
    assert.equal(
      isIgnorableAfterTestError(new Error('Unexpected error toast(s): boom')),
      false,
    )
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
