import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadComparison } from '@shared/store/thread-helpers.ts'
import type { ModelComparison } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// The model-comparison card mirrors the post-turn review card: it renders inside
// the scrolling message list (not a pinned sibling host) as a trailing card, and
// new messages arriving after it are inserted above it.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
    index: { resolveFileReferences: () => Promise.resolve([]) },
  } as unknown as ApiClient
}

const comparison: ModelComparison = {
  status: 'done',
  models: { a: 'gpt-5', b: 'claude-opus-4-8', judge: 'claude-opus-4-8' },
  reviewA: 'A verdict.',
  reviewB: 'B verdict.',
  synthesis: 'Comparison.',
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('model comparison renders inline in the transcript (component)', () => {
  it('mounts the comparison card as the last child of .messages-list', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Done with the change.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadComparison(store, threadId, comparison)

    const card = document.querySelector('[data-comparison-card]')
    assert.ok(card, 'expected the comparison card to render')
    const list = document.querySelector('.messages-list')
    assert.ok(list)
    assert.ok(list.contains(card), 'comparison card must scroll with the conversation')
    assert.equal(list.lastElementChild, card, 'comparison card should be the last child')
  })

  it('keeps the comparison card last when a new message arrives after it', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'First turn.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadComparison(store, threadId, comparison)
    addMessage(store, threadId, 'user', 'Another request.')

    const list = document.querySelector('.messages-list')
    assert.ok(list)
    const card = list.querySelector('[data-comparison-card]')
    assert.ok(card)
    assert.equal(list.lastElementChild, card, 'a later message must be inserted above the card')
  })

  it('replaces the previous comparison card on each update', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Working.')

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    setThreadComparison(store, threadId, {
      status: 'running',
      models: comparison.models,
      reviewA: '',
      reviewB: '',
      synthesis: '',
    })
    setThreadComparison(store, threadId, comparison)

    const cards = document.querySelectorAll('[data-comparison-card]')
    assert.equal(cards.length, 1, 'only one comparison card should exist after an update')
  })
})
