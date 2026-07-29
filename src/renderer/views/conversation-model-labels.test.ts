import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function fakeApi(): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
    } satisfies ApiClient
  })()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('primary-chat model labels', () => {
  it('hides model labels when every assistant turn used the same model', () => {
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

    assert.equal(document.querySelectorAll('.message-model').length, 0)
  })

  it('shows a model label at each model-segment boundary once two models appear', () => {
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

  it('omits labels on same-model continuations after a switch', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'one')
    addMessage(store, threadId, 'assistant', 'sonnet a', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    addMessage(store, threadId, 'user', 'two')
    addMessage(store, threadId, 'assistant', 'sonnet b', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    addMessage(store, threadId, 'user', 'three')
    addMessage(store, threadId, 'assistant', 'local a', undefined, undefined, {
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
    })
    addMessage(store, threadId, 'user', 'four')
    addMessage(store, threadId, 'assistant', 'local b', undefined, undefined, {
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
    })
    addMessage(store, threadId, 'user', 'five')
    addMessage(store, threadId, 'assistant', 'sonnet again', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const labeled = [...document.querySelectorAll('.msg-assistant')].map((msgEl) => {
      const label = msgEl.querySelector('.message-model')
      return label?.textContent ?? null
    })
    assert.deepEqual(labeled, [
      'Claude Sonnet 4.6',
      null,
      'qwen/qwen3.6-35b-a3b · local',
      null,
      'Claude Sonnet 4.6',
    ])
  })

  it('does not count missing model provenance toward the multi-model gate', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'legacy', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    addMessage(store, threadId, 'assistant', 'also legacy')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    assert.equal(document.querySelectorAll('.message-model').length, 0)
  })
})
