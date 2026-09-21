import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { buildBudgetExhaustedTodoNote } from '@copse/agent/agent-loop-guards.ts'

// The auto-continuation budget-exhausted note (#1410) is pushed into the
// thread as a plain assistant text message — the same mechanism as the
// pre-existing "still has open items" note — so it renders and persists like
// any other assistant turn. This proves it reaches the transcript with its
// specific, actionable content (which todos, how many attempts, that another
// message re-arms the budget), not just that generic assistant text renders.

function fakeApi(): ApiClient {
  return createFakeApi()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('budget-exhausted todo note in the transcript (#1410)', () => {
  it('renders the note naming the open todos and the closeout attempt outcome', () => {
    const note = buildBudgetExhaustedTodoNote(
      [
        { id: '1', content: 'Wire up the export button', status: 'pending' },
        { id: '2', content: 'Add a loading spinner', status: 'in_progress' },
      ],
      2,
      true,
    )

    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', note)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const textEl = document.querySelector('.msg-assistant .message-text')
    assert.ok(textEl, 'assistant message text is rendered')
    assert.match(textEl.textContent, /auto-continuation budget/)
    assert.match(textEl.textContent, /Wire up the export button/)
    assert.match(textEl.textContent, /Add a loading spinner/)
    assert.match(textEl.textContent, /2 closeout attempts ran/)
    assert.match(textEl.textContent, /Sending another message starts a fresh turn/)
  })
})
