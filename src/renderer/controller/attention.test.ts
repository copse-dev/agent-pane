import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  setAttentionThreads,
  isThreadAwaitingAttention,
  getAttentionThreadIds,
  resetAttention,
} from './attention.ts'

describe('attention controller', () => {
  beforeEach(() => {
    resetAttention()
  })

  it('flags threads set by a source and clears when the set empties', () => {
    const store = createStore()
    setAttentionThreads(store, 'approval', ['t1', 't2'])
    assert.equal(isThreadAwaitingAttention('t1'), true)
    assert.equal(isThreadAwaitingAttention('t2'), true)
    assert.equal(isThreadAwaitingAttention('t3'), false)

    setAttentionThreads(store, 'approval', [])
    assert.equal(isThreadAwaitingAttention('t1'), false)
  })

  it('unions across sources so neither clobbers the other', () => {
    const store = createStore()
    setAttentionThreads(store, 'approval', ['t1'])
    setAttentionThreads(store, 'ask', ['t2'])
    assert.deepEqual(getAttentionThreadIds().sort(), ['t1', 't2'])

    // Clearing one source leaves the other's flags intact.
    setAttentionThreads(store, 'approval', [])
    assert.deepEqual(getAttentionThreadIds(), ['t2'])
  })

  it('emits attention_changed only when the union actually changes', () => {
    const store = createStore()
    let emits = 0
    store.on('attention_changed', () => {
      emits += 1
    })

    setAttentionThreads(store, 'approval', ['t1'])
    assert.equal(emits, 1)

    // Same union from a different source ordering — no change, no emit.
    setAttentionThreads(store, 'ask', ['t1'])
    assert.equal(emits, 1)

    // A genuinely new thread — one more emit.
    setAttentionThreads(store, 'ask', ['t1', 't2'])
    assert.equal(emits, 2)
  })
})
