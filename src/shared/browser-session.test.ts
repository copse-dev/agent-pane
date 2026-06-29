import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_AGENT_SESSION_PARTITION,
  BROWSER_SESSION_PARTITION,
  isBrowserSessionPartition,
} from './browser-session.ts'

describe('browser-session', () => {
  it('recognizes both isolated browser partitions', () => {
    assert.equal(isBrowserSessionPartition(BROWSER_SESSION_PARTITION), true)
    assert.equal(isBrowserSessionPartition(BROWSER_AGENT_SESSION_PARTITION), true)
    assert.equal(isBrowserSessionPartition(''), false)
    assert.equal(isBrowserSessionPartition('persist:other'), false)
  })

  it('uses distinct partitions for the pane and the agent', () => {
    assert.notEqual(BROWSER_SESSION_PARTITION, BROWSER_AGENT_SESSION_PARTITION)
  })
})
