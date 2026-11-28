import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { testFileConcurrency } from './test-concurrency.mts'

describe('unit test file concurrency', () => {
  it('keeps CI at four whatever the runner has', () => {
    assert.equal(testFileConcurrency({ CI: 'true' }, 4), 4)
    assert.equal(testFileConcurrency({ CI: 'true' }, 64), 4)
  })

  it('uses a local host’s cores less two, between four and eight', () => {
    assert.equal(testFileConcurrency({}, 4), 4)
    assert.equal(testFileConcurrency({}, 8), 6)
    assert.equal(testFileConcurrency({}, 10), 8)
    assert.equal(testFileConcurrency({}, 32), 8)
  })

  it('takes an explicit COPSE_TEST_CONCURRENCY, and ignores one that is not a count', () => {
    assert.equal(testFileConcurrency({ COPSE_TEST_CONCURRENCY: '2' }, 10), 2)
    assert.equal(testFileConcurrency({ CI: 'true', COPSE_TEST_CONCURRENCY: '6' }, 4), 6)
    const warnings: string[] = []
    assert.equal(
      testFileConcurrency({ COPSE_TEST_CONCURRENCY: 'many' }, 10, (message) => {
        warnings.push(message)
      }),
      8,
    )
    assert.deepEqual(warnings, [
      '[run-tests] ignoring COPSE_TEST_CONCURRENCY=many: not a positive integer',
    ])
  })

  it('runs the Apple container files one at a time', () => {
    assert.equal(testFileConcurrency({ COPSE_THREAD_CONTAINER_E2E: 'apple' }, 10), 1)
  })
})
