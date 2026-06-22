import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_SESSION_PARTITION, isBrowserSessionPartition } from './browser-session.ts'

describe('browser-session', () => {
  it('recognizes the browser partition', () => {
    assert.equal(isBrowserSessionPartition(BROWSER_SESSION_PARTITION), true)
    assert.equal(isBrowserSessionPartition(''), false)
    assert.equal(isBrowserSessionPartition('persist:other'), false)
  })
})
