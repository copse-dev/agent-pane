import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, addToolCall, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function fakeApi(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: { ...base['agent'], run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } satisfies ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
})

/** A capable-model turn: one working bubble with a tool call, then the summary. */
function seedCapableTurn(conciseThreadsEnabled: boolean): ReturnType<typeof createStore> {
  const store = createStore({ conciseThreadsEnabled })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Fix the footer')
  const working = addMessage(
    store,
    threadId,
    'assistant',
    'Reading the form.',
    undefined,
    undefined,
    {
      model: 'claude-opus-5-5',
    },
  )
  addToolCall(store, working, {
    id: 'read-1',
    name: 'read_file',
    args: { path: 'form.ts' },
    status: 'done',
    result: '',
  })
  addMessage(store, threadId, 'assistant', 'Save now stays pinned.', undefined, undefined, {
    model: 'claude-opus-5-5',
  })
  return store
}

function conciseClasses(): string[][] {
  return [...document.querySelectorAll<HTMLElement>('.msg-assistant')].map((msgEl) =>
    [...msgEl.classList].filter((name) => name.startsWith('msg-concise')),
  )
}

describe('concise thread view in the conversation', () => {
  it('renders a capable model in full while the experimental setting is off', () => {
    const store = seedCapableTurn(false)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    assert.deepEqual(conciseClasses(), [[], []])
  })

  it('applies the concise view when the setting is on', () => {
    const store = seedCapableTurn(true)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    assert.deepEqual(conciseClasses(), [['msg-concise', 'msg-concise-working'], ['msg-concise']])
  })

  it('re-applies to rendered messages when the setting flips', () => {
    const store = seedCapableTurn(false)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    store.setState({ conciseThreadsEnabled: true })
    store.emit('settings_changed')
    assert.deepEqual(conciseClasses(), [['msg-concise', 'msg-concise-working'], ['msg-concise']])

    store.setState({ conciseThreadsEnabled: false })
    store.emit('settings_changed')
    assert.deepEqual(conciseClasses(), [[], []])
  })
})
