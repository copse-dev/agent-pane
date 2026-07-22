import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } as unknown as ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('primary-chat model labels', () => {
  it('shows a model label on each assistant turn with provenance (single model)', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'one')
    addMessage(store, threadId, 'assistant', 'reply a', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    addMessage(store, threadId, 'user', 'two')
    addMessage(store, threadId, 'assistant', 'reply b', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const labels = [...document.querySelectorAll('.message-model')].map((n) => n.textContent)
    assert.deepEqual(labels, ['claude-sonnet-4-6', 'claude-sonnet-4-6'])
  })

  it('shows a model label on each assistant turn when models differ', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'one')
    addMessage(store, threadId, 'assistant', 'from sonnet', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    addMessage(store, threadId, 'user', 'two')
    addMessage(store, threadId, 'assistant', 'from local', undefined, undefined, {
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const labels = [...document.querySelectorAll('.message-model')].map((n) => n.textContent)
    assert.deepEqual(labels, ['Claude Sonnet 4.6', 'qwen/qwen3.6-35b-a3b · local'])
  })

  it('skips assistant turns that lack model provenance', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'legacy', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    addMessage(store, threadId, 'assistant', 'also legacy')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const labels = [...document.querySelectorAll('.message-model')].map((n) => n.textContent)
    assert.deepEqual(labels, ['claude-sonnet-4-6'])
  })
})
