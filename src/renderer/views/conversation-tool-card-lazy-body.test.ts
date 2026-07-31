import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, addToolCall, updateToolCall } from '@shared/store/thread-helpers.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { ToolCall } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// A collapsed tool card's body (arguments + result) is expensive to build —
// a full markdown render pass for ACP results — and most tool calls stay
// collapsed. It should not exist in the DOM at all until the card opens.

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

const doneCall: ToolCall = {
  id: 'tc-done-1',
  name: 'read_file',
  args: { path: 'README.md' },
  status: 'done',
  result: '# Copse',
}

const runningCall: ToolCall = {
  id: 'tc-running-1',
  name: 'read_file',
  args: { path: 'notes.md' },
  status: 'running',
  result: null,
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('collapsed tool card bodies render lazily', () => {
  it('does not build the args/result DOM for a collapsed card', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, doneCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(card, 'expected a tool card')
    assert.equal(card.open, false, 'a completed, never-opened card starts collapsed')
    assert.equal(card.querySelector('.tool-result'), null, 'result body should not exist yet')
    assert.equal(card.querySelector('.tool-args'), null, 'args body should not exist yet')
  })

  it('builds the body the first time the card is opened', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, doneCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(card)
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))

    const resultEl = card.querySelector('.tool-result')
    assert.ok(resultEl, 'expected the result body to be built after opening')
    assert.match(resultEl.textContent, /# Copse/)
  })

  it('builds the body up front for a running (auto-expanded) card', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, runningCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-running-1"]')
    assert.ok(card)
    assert.equal(card.open, true, 'a running tool card auto-expands')
    assert.ok(card.querySelector('.tool-args'), 'expected the args body to already be built')
  })

  it('builds the body for a card restored open across a reconcile tick', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, doneCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(card)
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))
    // happy-dom doesn't implement <details>'s native toggle-on-click default
    // action, so flip the open state ourselves — a real browser click on the
    // summary would do both this and fire the listener dispatched above.
    card.open = true
    assert.ok(card.querySelector('.tool-result'), 'sanity: body built after opening')

    // Changing the tool call's own result changes its signature, so the next
    // tool_call_updated tick rebuilds the card from scratch (freshly
    // collapsed) and then restores the user's expansion from the DOM state it
    // captured beforehand.
    updateToolCall(store, messageId, 'tc-done-1', { result: '# Copse (updated)' })

    const rebuilt = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(rebuilt)
    assert.notStrictEqual(rebuilt, card, 'sanity: the card was actually rebuilt')
    assert.equal(rebuilt.open, true, 'expansion survives the reconcile')
    const resultAfter = rebuilt.querySelector('.tool-result')
    assert.ok(
      resultAfter,
      'a card restored open must have its body rendered, not just the flag flipped',
    )
    assert.match(resultAfter.textContent, /# Copse \(updated\)/)
  })
})
