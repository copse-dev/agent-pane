import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { CHIP_CHAR } from './composer-editor.ts'

// Renders a sent user message carrying transcript attachments (input-bar.ts
// builds these on send) and asserts the composer's paste chip appears inline at
// its U+FFFC placeholder while file/thread refs follow in a trailing row — each
// an SVG-icon chip, no emoji.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } as unknown as ApiClient
}

function mountWithUserMessage(
  content: string,
  attachments: Parameters<typeof addMessage>[5],
): void {
  const store = createStore()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', content, undefined, attachments)
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('user transcript attachment chips', () => {
  it('renders the paste chip inline at its placeholder, files/threads in a trailing row', () => {
    mountWithUserMessage(`apply this ${CHIP_CHAR} to the intro`, [
      { kind: 'paste', label: 'Editor feedback' },
      { kind: 'file', label: 'notes.txt' },
      { kind: 'thread', label: 'Auth refactor' },
    ])

    const textEl = document.querySelector('.msg-user .message-text')
    assert.ok(textEl, 'user message text is rendered')

    // The paste chip sits inline, between the surrounding text nodes.
    const paste = textEl.querySelector('.transcript-attachment-chip.transcript-attachment-paste')
    assert.ok(paste, 'paste chip renders inline')
    assert.equal(
      paste.querySelector('.transcript-attachment-label')?.textContent,
      'Editor feedback',
    )
    assert.ok(
      paste.querySelector('svg[data-icon="paste"]'),
      'paste chip uses an SVG icon, not an emoji',
    )
    assert.match(textEl.textContent, /apply this .*Editor feedback.* to the intro/)

    // Files and threads follow in a trailing row.
    const row = textEl.querySelector('.transcript-attachment-row')
    assert.ok(row, 'trailing attachment row renders')
    const rowChips = row.querySelectorAll('.transcript-attachment-chip')
    assert.equal(rowChips.length, 2)
    const file = row.querySelector('.transcript-attachment-file')
    const thread = row.querySelector('.transcript-attachment-thread')
    assert.ok(file, 'file chip renders')
    assert.ok(thread, 'thread chip renders')
    assert.equal(file.querySelector('.transcript-attachment-label')?.textContent, 'notes.txt')
    assert.ok(file.querySelector('svg[data-icon="file"]'))
    assert.equal(thread.querySelector('.transcript-attachment-label')?.textContent, 'Auth refactor')
    assert.ok(thread.querySelector('svg[data-icon="thread"]'))

    // No object-replacement placeholder leaks into the visible text.
    assert.doesNotMatch(textEl.textContent, new RegExp(CHIP_CHAR))
  })

  it('renders plain user messages unchanged when there are no attachments', () => {
    mountWithUserMessage('just a normal message', undefined)
    const textEl = document.querySelector('.msg-user .message-text')
    assert.ok(textEl, 'user message text is rendered')
    assert.equal(textEl.textContent, 'just a normal message')
    assert.equal(textEl.querySelector('.transcript-attachment-chip'), null)
  })
})
