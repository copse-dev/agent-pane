import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from '../controller/message-queue.ts'
import { mountConversation } from './conversation.ts'

// Component port of tests/e2e/queued-message-edit.e2e.ts. The queued-message
// controller (updateQueuedMessageText/sendQueuedMessageNow) is unit-tested in
// controller/message-queue.test.ts, but the inline EDIT *view* — startEditing /
// buildQueuedEditor / saveEditing inside conversation.ts — is exercised nowhere
// else, so this happy-dom port is its only coverage. The e2e badge text reads
// "QUEUED"/"EDITING" only because of CSS text-transform: uppercase; the DOM
// textContent is "Queued"/"Editing", which is what we assert here.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } as unknown as ApiClient
}

const ORIGINAL = 'Then add unit tests for the parser.'
const EDITED = 'Then add unit tests AND integration tests for the parser.'

// Mount conversation with one queued follow-up on a running thread, exactly as
// the submit-while-running path produces it (addMessage then enqueueUserMessage).
function mountWithQueued() {
  const store = createStore()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  const messageId = addMessage(store, threadId, 'user', ORIGINAL)
  enqueueUserMessage(store, threadId, { messageId, payload: { content: ORIGINAL }, createdAt: 1 })
  return { store, threadId, messageId }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('queued message edit (component)', () => {
  it('exposes a single Edit / Send-now action row on a queued message', () => {
    const { messageId } = mountWithQueued()

    const queued = document.querySelector(`.msg-queued[data-message-id="${messageId}"]`)
    assert.ok(queued, 'expected a queued message bubble')
    assert.equal(queued.querySelector('.message-queued-badge')?.textContent, 'Queued')
    assert.ok(queued.querySelector('.queued-edit'), 'expected an Edit button')
    assert.ok(queued.querySelector('.queued-send-now'), 'expected a Send now button')
    // Exactly one action row — guards against duplicate decoration on re-render.
    assert.equal(queued.querySelectorAll('.message-queued-actions').length, 1)
  })

  it('Edit pauses the queue and opens an inline editor seeded with the queued text', () => {
    const { store, threadId, messageId } = mountWithQueued()

    document.querySelector<HTMLButtonElement>('.msg-queued .queued-edit')?.click()

    const editing = document.querySelector(`.msg-editing[data-message-id="${messageId}"]`)
    assert.ok(editing, 'expected the message to switch to edit mode')
    assert.equal(editing.querySelector('.message-queued-badge')?.textContent, 'Editing')
    const input = editing.querySelector<HTMLTextAreaElement>('.message-edit-input')
    assert.ok(input, 'expected an inline edit textarea')
    assert.equal(input.value, ORIGINAL)
    assert.ok(editing.querySelector('.queued-send'), 'expected a Send button')
    assert.ok(editing.querySelector('.queued-cancel'), 'expected a Cancel button')
    // Editing pauses the queue so the agent can't drain it mid-edit.
    assert.equal(store.getState().threads.find((t) => t.id === threadId)?.queuePaused, true)
  })

  it('Send re-queues the message with the edited text', () => {
    const { store, threadId, messageId } = mountWithQueued()

    document.querySelector<HTMLButtonElement>('.msg-queued .queued-edit')?.click()
    const input = document.querySelector<HTMLTextAreaElement>('.message-edit-input')
    assert.ok(input)
    input.value = EDITED
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('.msg-editing .queued-send')?.click()

    // The thread is still running, so the message stays queued (no drain) — now
    // back to the Queued badge with its actions, showing the edited text in both
    // the rendered bubble and the stored payload.
    const queued = document.querySelector(`.msg-queued[data-message-id="${messageId}"]`)
    assert.ok(queued, 'expected the message to return to the queued state')
    assert.equal(queued.querySelector('.message-queued-badge')?.textContent, 'Queued')
    assert.equal(queued.querySelector('.message-text')?.textContent, EDITED)
    assert.ok(queued.querySelector('.queued-edit'), 'expected Edit available again')
    assert.equal(
      store.getState().threads.find((t) => t.id === threadId)?.pendingMessages?.[0]?.payload
        .content,
      EDITED,
    )
  })
})
