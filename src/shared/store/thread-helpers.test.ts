import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import {
  createThread,
  openNewThread,
  switchThread,
  addMessage,
  isBlankThread,
  hasUnsubmittedPrompt,
  normalizeBlankThreads,
  setThreadDraftPrompt,
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

  it('switching away from a blank thread keeps it when it has a draft prompt', () => {
    const store = createStore()
    const usedId = createThread(store)
    addMessage(store, usedId, 'user', 'hello')
    const draftBlankId = createThread(store)
    setThreadDraftPrompt(store, draftBlankId, 'still typing…')

    switchThread(store, usedId)
    const draftBlank = store.getState().threads.find((t) => t.id === draftBlankId)
    assert.ok(draftBlank)
    assert.equal(draftBlank?.draftPrompt, 'still typing…')
    assert.equal(hasUnsubmittedPrompt(draftBlank!), true)
  })

  it('openNewThread creates a new blank when the only blank has a draft', () => {
    const store = createStore()
    const usedId = createThread(store)
    addMessage(store, usedId, 'user', 'hello')
    const draftBlankId = createThread(store)
    setThreadDraftPrompt(store, draftBlankId, 'draft')

    const openedId = openNewThread(store)
    assert.notEqual(openedId, draftBlankId)
    assert.equal(
      store.getState().threads.some((t) => t.id === draftBlankId),
      true,
    )
    assert.equal(store.getState().activeThreadId, openedId)
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

  it('normalizeBlankThreads keeps blank threads that have draft prompts', () => {
    const store = createStore()
    const draftBlank = createThread(store)
    setThreadDraftPrompt(store, draftBlank, 'saved draft')
    const emptyA = createThread(store)
    const emptyB = createThread(store)
    assert.equal(store.getState().threads.length, 3)

    normalizeBlankThreads(store)
    const threads = store.getState().threads
    assert.equal(
      threads.some((t) => t.id === draftBlank),
      true,
    )
    assert.equal(threads.filter(isBlankThread).length, 2)
    assert.equal(threads.filter((t) => isBlankThread(t) && !hasUnsubmittedPrompt(t)).length, 1)
    assert.equal(
      threads.some((t) => t.id === emptyA || t.id === emptyB),
      true,
    )
  })
})
