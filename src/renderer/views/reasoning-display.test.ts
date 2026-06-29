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
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// Component eval for the live "Thinking" reasoning disclosure. Reasoning tokens
// stream in via `appendReasoning` (which emits `message_reasoning`); the view
// should surface them in a collapsible <details> above the answer, keep it open
// while the answer is still empty, and tuck it away once the answer lands. The
// activity row doubles as a click target that opens the latest trail.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } as unknown as ApiClient
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
    const { store, messageId } = mountWithReasoning()

    appendReasoning(store, messageId, 'Let me ')
    appendReasoning(store, messageId, 'check the file.')

    const details = document.querySelector('.message-reasoning') as HTMLDetailsElement | null
    assert.ok(details, 'expected a reasoning disclosure')
    // Live (no answer yet): open by default so the user sees the thinking.
    assert.equal(details.open, true)
    assert.equal(details.querySelector('.message-reasoning-title')?.textContent, 'Thinking')
    assert.equal(
      details.querySelector('.message-reasoning-text')?.textContent,
      'Let me check the file.',
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

  it('collapses the trail once the answer arrives, unless the user opened it', () => {
    const { store, messageId } = mountWithReasoning()
    appendReasoning(store, messageId, 'thinking…')
    appendToken(store, messageId, 'Here is the answer.')
    store.emit('message_done', messageId)

    const details = document.querySelector('.message-reasoning') as HTMLDetailsElement
    assert.equal(details.open, false)
  })

  it('makes the activity row open the latest reasoning trail on click', () => {
    const { store, threadId, messageId } = mountWithReasoning()
    appendReasoning(store, messageId, 'thinking…')
    // The agent controller emits this label while the model reasons.
    store.emit('agent_activity', threadId, 'Thinking…')

    const activity = document.querySelector('.agent-activity') as HTMLElement
    assert.ok(activity.classList.contains('agent-activity-clickable'))

    // Collapse first to prove the click re-opens it.
    const details = document.querySelector('.message-reasoning') as HTMLDetailsElement
    details.open = false
    activity.dispatchEvent(new Event('click', { bubbles: true }))
    assert.equal(details.open, true)
  })
})
