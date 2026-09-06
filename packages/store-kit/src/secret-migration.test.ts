import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { registerSecretSweep, requestSecretSweep, resetSecretSweeps } from './secret-migration.ts'

describe('secret-format sweeps', () => {
  beforeEach(() => {
    resetSecretSweeps()
  })

  it('runs every registered sweep on the first request and no more', () => {
    let a = 0
    let b = 0
    registerSecretSweep(() => {
      a += 1
    })
    registerSecretSweep(() => {
      b += 1
    })

    requestSecretSweep()
    requestSecretSweep()

    assert.deepEqual([a, b], [1, 1])
  })

  it('runs a sweep registered after the request, so load order costs nothing', () => {
    requestSecretSweep()

    let swept = 0
    registerSecretSweep(() => {
      swept += 1
    })

    assert.equal(swept, 1)
    // Already caught up: a later request must not run it a second time.
    requestSecretSweep()
    assert.equal(swept, 1)
  })

  it('ignores the re-entrant request a sweep makes while migrating', () => {
    let swept = 0
    registerSecretSweep(() => {
      swept += 1
      // What a store does when its own rewrite reports success mid-sweep.
      requestSecretSweep()
    })

    requestSecretSweep()

    assert.equal(swept, 1)
  })

  it('keeps sweeping when one store throws', () => {
    let reached = false
    registerSecretSweep(() => {
      throw new Error('keyring re-locked')
    })
    registerSecretSweep(() => {
      reached = true
    })

    assert.doesNotThrow(() => {
      requestSecretSweep()
    })
    assert.equal(reached, true)
  })
})
