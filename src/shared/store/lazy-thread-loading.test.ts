import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import { isBlankThread, normalizeBlankThreads, switchThread } from './thread-helpers.ts'
import type { Thread } from '@shared/types'

/**
 * Guards the invariant that makes lazy thread loading safe to ship.
 *
 * Threads load as metadata only — `messages: []` with `messagesLoaded: false`.
 * `isBlankThread` reads an empty transcript as "new, unused thread";
 * `pruneBlankThreads` drops those from the store; and the autosave reconciler
 * emits `threads:delete` for anything that left it. Chained together, treating
 * an unloaded transcript as blank DELETES THE USER'S ENTIRE CHAT HISTORY on the
 * first launch after loading turns lazy.
 *
 * These tests are the tripwire for that chain. If one of them fails, the failure
 * is data loss, not a cosmetic regression.
 */

function loadedThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** A thread as `threads:loadProject` returns it: metadata, no transcript. */
function unloadedThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return loadedThread(id, { messagesLoaded: false, ...overrides })
}

describe('lazy thread loading: unloaded transcripts are never blank', () => {
  it('does not treat a thread with an unread transcript as blank', () => {
    assert.equal(isBlankThread(unloadedThread('a')), false)
  })

  it('still treats a genuinely empty in-memory thread as blank', () => {
    // `messagesLoaded: true` is what the meta reader sets for a thread whose
    // spine file is empty, so blank-thread handling for new threads is unchanged.
    assert.equal(isBlankThread(loadedThread('a', { messagesLoaded: true })), true)
    // Threads built in memory never set the field at all.
    assert.equal(isBlankThread(loadedThread('a')), true)
  })

  it('a thread that is loaded and has messages is not blank', () => {
    const thread = loadedThread('a', {
      messagesLoaded: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1 }],
    })
    assert.equal(isBlankThread(thread), false)
  })

  it('normalizeBlankThreads keeps every unloaded thread', () => {
    const store = createStore()
    const threads = Array.from({ length: 25 }, (_, i) => unloadedThread(`t${String(i)}`))
    store.setState({ threads, activeThreadId: 't0' })

    normalizeBlankThreads(store)

    assert.equal(store.getState().threads.length, 25, 'no unloaded thread may be pruned')
  })

  it('switching threads does not prune the unloaded ones it passes over', () => {
    const store = createStore()
    const threads = Array.from({ length: 10 }, (_, i) => unloadedThread(`t${String(i)}`))
    store.setState({ threads, activeThreadId: 't0' })

    switchThread(store, 't7')

    assert.equal(store.getState().threads.length, 10)
    assert.equal(store.getState().activeThreadId, 't7')
  })

  it('still collapses surplus in-memory blanks, so the old behaviour survives', () => {
    const store = createStore()
    store.setState({
      threads: [
        loadedThread('keep', { createdAt: 3 }),
        loadedThread('drop', { createdAt: 2 }),
        unloadedThread('unloaded', { createdAt: 1 }),
      ],
      activeThreadId: 'keep',
    })

    normalizeBlankThreads(store)

    const ids = store.getState().threads.map((t) => t.id)
    assert.ok(ids.includes('keep'))
    assert.ok(ids.includes('unloaded'), 'an unloaded thread is not a surplus blank')
    assert.ok(!ids.includes('drop'), 'surplus empty blanks are still collapsed')
  })
})
