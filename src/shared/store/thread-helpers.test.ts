import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import {
  createThread,
  openNewThread,
  switchThread,
  addMessage,
  isBlankThread,
  normalizeBlankThreads,
} from './thread-helpers.ts'

describe('blank thread reuse', () => {
  it('openNewThread reuses an existing blank thread instead of creating another', () => {
    const store = createStore()
    const firstId = createThread(store)
    addMessage(store, firstId, 'user', 'hello')

    const blankId = createThread(store)
    assert.equal(store.getState().threads.length, 2)

    const openedId = openNewThread(store)
    assert.equal(openedId, blankId)
    assert.equal(store.getState().threads.length, 2)
    assert.equal(store.getState().activeThreadId, blankId)
  })

  it('switching away from a blank thread removes unused blanks', () => {
    const store = createStore()
    const usedId = createThread(store)
    addMessage(store, usedId, 'user', 'hello')
    const blankId = createThread(store)

    switchThread(store, usedId)
    assert.equal(
      store.getState().threads.some((t) => t.id === blankId),
      false,
    )
    assert.equal(store.getState().activeThreadId, usedId)
  })

  it('normalizeBlankThreads collapses multiple blanks on load', () => {
    const store = createStore()
    const blankA = createThread(store)
    const blankB = createThread(store)
    assert.equal(store.getState().threads.length, 2)

    normalizeBlankThreads(store)
    const threads = store.getState().threads
    assert.equal(threads.filter(isBlankThread).length, 1)
    assert.equal(store.getState().activeThreadId, blankB)
    assert.equal(
      threads.some((t) => t.id === blankA),
      false,
    )
  })
})
