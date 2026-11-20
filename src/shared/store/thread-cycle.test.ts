import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import {
  addMessage,
  archiveThread,
  createThread,
  nextThreadId,
  prevThreadId,
  switchThread,
} from './thread-helpers.ts'

/** Build a store whose thread list is [a, b, c] (newest first) with `a` active. */
function storeWithThreads(): ReturnType<typeof createStore> {
  const store = createStore()
  const c = createThread(store)
  addMessage(store, c, 'user', 'c')
  const b = createThread(store)
  addMessage(store, b, 'user', 'b')
  const a = createThread(store)
  addMessage(store, a, 'user', 'a')
  return store // activeThreadId === a, threads = [a, b, c]
}

describe('nextThreadId / prevThreadId', () => {
  it('returns null when there are no threads', () => {
    const store = createStore()
    assert.equal(nextThreadId(store), null)
    assert.equal(prevThreadId(store), null)
  })

  it('returns null when there is a single thread', () => {
    const store = createStore()
    createThread(store)
    assert.equal(nextThreadId(store), null)
    assert.equal(prevThreadId(store), null)
  })

  it('is forward through the list, wrapping from the last back to the first', () => {
    const store = storeWithThreads()
    const [a, b, c] = store.getState().threads.map((t) => t.id)
    assert.ok(a)
    assert.ok(b)
    assert.ok(c)

    assert.equal(nextThreadId(store), b)
    switchThread(store, b)
    assert.equal(nextThreadId(store), c)
    switchThread(store, c)
    assert.equal(nextThreadId(store), a)
  })

  it('is backward through the list, wrapping from the first back to the last', () => {
    const store = storeWithThreads()
    const [a, b, c] = store.getState().threads.map((t) => t.id)
    assert.ok(a)
    assert.ok(b)
    assert.ok(c)

    assert.equal(prevThreadId(store), c)
    switchThread(store, c)
    assert.equal(prevThreadId(store), b)
    switchThread(store, b)
    assert.equal(prevThreadId(store), a)
  })

  it('skips archived threads, which stay in the store but are not listed', () => {
    const store = storeWithThreads()
    const [a, b, c] = store.getState().threads.map((t) => t.id)
    assert.ok(a)
    assert.ok(b)
    assert.ok(c)
    archiveThread(store, b)
    switchThread(store, a)

    assert.equal(nextThreadId(store), c)
    assert.equal(prevThreadId(store), c)
    switchThread(store, c)
    assert.equal(nextThreadId(store), a)
    assert.equal(prevThreadId(store), a)
  })

  it('returns null when every other thread is archived', () => {
    const store = storeWithThreads()
    const [a, b, c] = store.getState().threads.map((t) => t.id)
    assert.ok(a)
    assert.ok(b)
    assert.ok(c)
    archiveThread(store, b)
    archiveThread(store, c)
    switchThread(store, a)

    assert.equal(nextThreadId(store), null)
    assert.equal(prevThreadId(store), null)
  })
})
