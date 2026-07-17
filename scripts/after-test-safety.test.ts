import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isMochaTimeoutError, withTimeout } from '../tests/e2e/helpers/after-test-safety.ts'

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
