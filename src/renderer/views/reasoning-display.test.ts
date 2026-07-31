import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  addMessage,
  appendReasoning,
  appendToken,
  createThread,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// Component eval for the live "Reasoning" disclosure. Reasoning tokens stream
// in via `appendReasoning` (which emits `message_reasoning`); the view should
// surface them in a collapsible <details> above the answer, keep it open while
// the answer is still empty, and tuck it away once the answer lands. The
// initial activity row lives in the transcript, then folds into the live
// disclosure once reasoning tokens arrive.

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

function mountWithReasoning(): { store: AppStore; threadId: string; messageId: string } {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'assistant', '')
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  return { store, threadId, messageId }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('reasoning display (component)', () => {
  it('streams reasoning into an open disclosure above the answer', () => {
    const { store, threadId, messageId } = mountWithReasoning()
    setThreadStatus(store, threadId, 'running')

    appendReasoning(store, messageId, 'Let me ')
    appendReasoning(store, messageId, 'check the file.')

    const details = qsRequired<HTMLDetailsElement>(document, '.message-reasoning')
    assert.ok(details, 'expected a reasoning disclosure')
    // Live (no answer yet): open by default; progressive title.
    assert.equal(details.open, true)
    assert.equal(details.querySelector('.message-reasoning-title')?.textContent, 'Reasoning…')
    assert.ok(details.classList.contains('message-reasoning-live'))
    assert.ok(details.querySelector('[data-icon="reasoning-activity"]'))
    assert.equal(
      details.querySelector('.message-reasoning-text')?.innerHTML,
      // @copse/streaming-markdown ≥0.2 wraps a single prose line in <p> (styled
      // flush by .message-reasoning-text p); older versions emitted it bare.
      '<p>Let me check the file.</p>',
    )
    // Sits before the answer text in the body.
    const body = document.querySelector('.msg-assistant .message-body')
    assert.ok(body, 'expected an assistant message body')
    const answer = body.querySelector('.message-text')
    assert.ok(answer, 'expected an answer element')
    const children = [...body.children]
    assert.ok(
      children.indexOf(details) < children.indexOf(answer),
      'reasoning should render above the answer',
    )
  })

  it('renders markdown formatting in reasoning text', () => {
    const { store, messageId } = mountWithReasoning()

    appendReasoning(store, messageId, '**bold** and *italic* and `code`')

    const textEl = qsRequired(document, '.message-reasoning-text')
    assert.ok(textEl)
    assert.ok(textEl.innerHTML.includes('<strong>bold</strong>'))
    assert.ok(textEl.innerHTML.includes('<em>italic</em>'))
    assert.ok(textEl.innerHTML.includes('<code>code</code>'))
  })

  it('collapses the trail once the answer arrives, unless the user opened it', () => {
    const { store, messageId } = mountWithReasoning()
    appendReasoning(store, messageId, 'reasoning…')
    appendToken(store, messageId, 'Here is the answer.')
    store.emit('message_done', messageId)

    const details = qsRequired<HTMLDetailsElement>(document, '.message-reasoning')
    assert.equal(details.open, false)
    assert.equal(details.querySelector('.message-reasoning-title')?.textContent, 'Reasoned')
  })

  it('moves the waiting activity out of the composer and folds it into live reasoning', () => {
    const { store, threadId, messageId } = mountWithReasoning()
    const input = document.createElement('div')
    input.id = 'input-bar'
    document.body.append(input)

    setThreadStatus(store, threadId, 'running')
    store.emit('agent_activity', threadId, 'Reasoning…')
    const activity = qsRequired(document, '.agent-activity')
    assert.equal(activity.closest('.messages-list') !== null, true)
    assert.equal(input.contains(activity), false)
    assert.equal(activity.hidden, false)
    assert.ok(activity.querySelector('[data-icon="reasoning-activity"]'))

    appendReasoning(store, messageId, 'reasoning…')
    store.emit('agent_activity', threadId, 'Reasoning…')
    const details = qsRequired<HTMLDetailsElement>(document, '.message-reasoning')
    assert.equal(activity.hidden, true)
    assert.ok(details.classList.contains('message-reasoning-live'))
  })
})
