import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearActiveRunThread,
  clearThreadModels,
  getActiveRunThread,
  getThreadModels,
  recordThreadModel,
  setActiveRunThread,
} from './thread-models.ts'

afterEach(() => {
  clearThreadModels('t1')
  clearThreadModels('t2')
  setActiveRunThread(null)
})

describe('thread model tracking', () => {
  it('accumulates distinct models per thread in first-seen order', () => {
    recordThreadModel('t1', 'claude-opus-4-8')
    recordThreadModel('t1', 'gpt-4o')
    recordThreadModel('t1', 'claude-opus-4-8')
    assert.deepEqual(getThreadModels('t1'), ['claude-opus-4-8', 'gpt-4o'])
  })

  it('keeps threads isolated and ignores blank ids', () => {
    recordThreadModel('t1', 'claude-opus-4-8')
    recordThreadModel('t2', 'gpt-4o')
    recordThreadModel('t2', '')
    assert.deepEqual(getThreadModels('t2'), ['gpt-4o'])
    assert.deepEqual(getThreadModels('unknown'), [])
  })
})

describe('active run thread', () => {
  it('tracks the running thread and clears only its own pointer', () => {
    setActiveRunThread('t1')
    assert.equal(getActiveRunThread(), 't1')
    // A later run takes over; t1 finishing must not clear t2's pointer.
    setActiveRunThread('t2')
    clearActiveRunThread('t1')
    assert.equal(getActiveRunThread(), 't2')
    clearActiveRunThread('t2')
    assert.equal(getActiveRunThread(), null)
  })
})
