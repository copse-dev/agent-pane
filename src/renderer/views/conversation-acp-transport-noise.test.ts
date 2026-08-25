import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function fakeApi(): ApiClient {
  return createFakeApi()
}

const NOISY_ANSWER = [
  'https://github.com/copse-dev/agent-pane/pull/1818',
  '',
  'Error: RetriableError: WritableIterable is closed',
].join('\n')

afterEach(() => {
  document.body.replaceChildren()
})

describe('Cursor ACP transport noise demotion', () => {
  it('strips trailing RetriableError from the answer for regular users', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', NOISY_ANSWER)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const textEl = document.querySelector('.msg-assistant .message-text')
    assert.ok(textEl, 'assistant message text is rendered')
    assert.match(textEl.textContent, /pull\/1818/)
    assert.doesNotMatch(textEl.textContent, /WritableIterable/)
    assert.equal(document.querySelector('.acp-transport-noise'), null)
  })

  it('shows a collapsed disclosure when developer mode is on', () => {
    const store = createStore({ developerMode: true })
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', NOISY_ANSWER)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const textEl = document.querySelector('.msg-assistant .message-text')
    assert.ok(textEl, 'assistant message text is rendered')
    assert.match(textEl.textContent, /pull\/1818/)
    assert.doesNotMatch(textEl.textContent, /WritableIterable/)

    const details = document.querySelector<HTMLDetailsElement>(
      '.msg-assistant .acp-transport-noise',
    )
    assert.ok(details, 'transport noise disclosure is present')
    assert.equal(details.open, false)
    assert.equal(
      details.querySelector('.acp-transport-noise-summary')?.textContent,
      'Agent transport note',
    )
    assert.equal(
      details.querySelector('.acp-transport-noise-body')?.textContent,
      'Error: RetriableError: WritableIterable is closed',
    )
  })

  it('reveals the disclosure when developer mode is toggled on', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', NOISY_ANSWER)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    assert.equal(document.querySelector('.acp-transport-noise'), null)

    store.setState({ developerMode: true })
    store.emit('settings_changed')

    const details = document.querySelector<HTMLDetailsElement>(
      '.msg-assistant .acp-transport-noise',
    )
    assert.ok(details, 'transport noise disclosure appears after enabling developer mode')
    assert.equal(details.open, false)
  })

  it('leaves an error-only bubble visible', () => {
    const store = createStore({ developerMode: true })
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Error: RetriableError: WritableIterable is closed')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const textEl = document.querySelector('.msg-assistant .message-text')
    assert.ok(textEl)
    assert.match(textEl.textContent, /WritableIterable/)
    assert.equal(document.querySelector('.acp-transport-noise'), null)
  })
})
