import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadDraftPrompt } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// Component-level port of tests/e2e/composer-typing-no-rerender.e2e.ts. That spec
// guarded the "scroll + links flicker while typing" regression: the composer's
// debounced draft-save used to emit the coarse `threads_changed` event, which
// made the conversation view tear down and rebuild every message (re-render
// markdown, re-resolve links, reset scroll) on each keystroke.
//
// The regression decomposes into two facts, each testable without Electron:
//   1. saving a draft emits the fine `thread_draft_changed`, not `threads_changed`
//      — covered by src/shared/store/thread-helpers.test.ts
//   2. the conversation view does NOT rebuild on `thread_draft_changed`
//      — this test
// The composer→debounce→save wiring in between is the autosave unit
// (src/renderer/views/composer-draft-autosave.test.ts). Together they replace the
// e2e's end-to-end check. We drive fact 2 directly: mount the real view over a
// seeded message with a link, fire the draft event the save path emits, and
// assert the existing message + link DOM nodes survive by identity — a node
// changing identity would mean the list was rebuilt.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
    // annotateFileReferences early-returns when a message has no file-path
    // candidates, but stub the resolver so the rendered link can't trip it.
    index: { resolveFileReferences: () => Promise.resolve([]) },
  } as unknown as ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('conversation does not rebuild on draft-save events (component)', () => {
  it('keeps existing message and link DOM nodes when a thread draft changes', () => {
    const store = createStore()
    const threadId = createThread(store)
    // Mirrors seedBrowserLinkChatFixture: one assistant message with a link.
    const messageId = addMessage(
      store,
      threadId,
      'assistant',
      'See [Example Domain](https://example.com) for details.',
    )
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const msgNode = document.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(msgNode, 'expected the seeded assistant message to render')
    const linkNode = msgNode.querySelector('a')
    assert.ok(linkNode, 'expected the markdown link to render as an anchor')
    assert.match(linkNode.getAttribute('href') ?? '', /example\.com/)

    // Two draft saves, as two typing bursts would produce. Each emits
    // `thread_draft_changed`; the conversation must ignore it.
    setThreadDraftPrompt(store, threadId, 'investigating the flicker')
    setThreadDraftPrompt(store, threadId, 'investigating the flicker while typing into chat')

    // Same node objects ⇒ the conversation was not torn down and rebuilt.
    assert.equal(
      document.querySelector(`[data-message-id="${messageId}"]`),
      msgNode,
      'message node identity changed — the conversation rebuilt on a draft save',
    )
    assert.equal(
      document.querySelector(`[data-message-id="${messageId}"] a`),
      linkNode,
      'link node identity changed — the conversation rebuilt on a draft save',
    )
    assert.equal(document.querySelectorAll('.messages-list .msg').length, 1)
    assert.equal(document.querySelectorAll('.messages-list a[data-browser-link]').length, 1)
  })
})
