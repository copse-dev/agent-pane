import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { CHIP_CHAR } from './composer-editor.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'

// Renders a sent user message carrying transcript attachments (input-bar.ts
// builds these on send) and asserts the composer's paste chip appears inline at
// its U+FFFC placeholder while file/thread refs follow in a trailing row — each
// an SVG-icon chip, no emoji.

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
      { kind: 'paste', label: 'Editor feedback', content: 'Make the heading shorter.' },
      { kind: 'file', label: 'notes.txt', content: 'release checklist' },
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
    // The paste carries a snapshot, so its chip opens the preview like a file's.
    assert.equal(paste.getAttribute('role'), 'button')
    assert.equal(paste.getAttribute('tabindex'), '0')
    assert.equal(paste.getAttribute('aria-label'), 'Preview Editor feedback')
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
    assert.equal(file.getAttribute('role'), 'button')
    assert.equal(file.getAttribute('tabindex'), '0')
    assert.equal(file.getAttribute('aria-label'), 'Preview notes.txt')
    assert.equal(thread.querySelector('.transcript-attachment-label')?.textContent, 'Auth refactor')
    assert.ok(thread.querySelector('svg[data-icon="thread"]'))

    // No object-replacement placeholder leaks into the visible text.
    assert.doesNotMatch(textEl.textContent, new RegExp(CHIP_CHAR))
  })

  /**
   * The inline paste chip used to be rebuilt from its label alone, dropping the
   * snapshot the message already carried — so the single most common text
   * attachment was the one kind that would not open.
   */
  it('opens the pasted snapshot in the preview modal, not just its label', () => {
    patchPreviewDialog()
    mountWithUserMessage(`apply this ${CHIP_CHAR} to the intro`, [
      { kind: 'paste', label: 'Editor feedback', content: 'Make the heading shorter.' },
    ])

    const paste = document.querySelector<HTMLElement>('.transcript-attachment-paste')
    assert.ok(paste, 'paste chip renders inline')
    paste.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

    const dialog = document.querySelector<HTMLDialogElement>('.attachment-preview-dialog')
    assert.ok(dialog, 'the shared attachment dialog opened')
    assert.equal(dialog.open, true)
    assert.equal(dialog.dataset['previewKind'], 'text')
    assert.equal(
      dialog.querySelector('.attachment-preview-text')?.textContent,
      'Make the heading shorter.',
    )
    dialog.close()
  })

  /**
   * Placeholders are matched to pastes by order, so a message can carry more
   * CHIP_CHARs than attachments (a legacy spine, a truncated edit). The extra
   * chip has no snapshot behind it and stays display-only rather than opening
   * an empty modal.
   */
  it('leaves a paste chip display-only when no attachment matches its placeholder', () => {
    mountWithUserMessage(`apply this ${CHIP_CHAR} and this ${CHIP_CHAR} to the intro`, [
      { kind: 'paste', label: 'Editor feedback', content: 'Make the heading shorter.' },
    ])

    const pastes = document.querySelectorAll<HTMLElement>('.transcript-attachment-paste')
    assert.equal(pastes.length, 2, 'both placeholders render a chip')
    const matched = pastes[0]
    const unmatched = pastes[1]
    assert.ok(matched)
    assert.ok(unmatched)
    assert.equal(matched.getAttribute('aria-label'), 'Preview Editor feedback')
    assert.equal(
      unmatched.querySelector('.transcript-attachment-label')?.textContent,
      'Pasted text',
    )
    assert.equal(unmatched.getAttribute('role'), null, 'the unmatched chip is not clickable')
  })

  it('renders plain user messages unchanged when there are no attachments', () => {
    mountWithUserMessage('just a normal message', undefined)
    const textEl = document.querySelector('.msg-user .message-text')
    assert.ok(textEl, 'user message text is rendered')
    assert.equal(textEl.textContent, 'just a normal message')
    assert.equal(textEl.querySelector('.transcript-attachment-chip'), null)
  })

  it('renders user prompts with markdown and preserved line breaks', () => {
    mountWithUserMessage('line one\nline two\n\n**bold**', undefined)
    const textEl = document.querySelector('.msg-user .message-text')
    assert.ok(textEl, 'user message text is rendered')
    assert.ok(textEl.querySelector('strong'), 'markdown emphasis is rendered')
    assert.ok(textEl.querySelector('br'), 'single newlines render as line breaks')
    assert.match(textEl.textContent, /line one\s*line two/)
  })

  it('shows a text-only resend recovery for an image prompt rejected by its model', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'Describe this', ['data:image/png;base64,abc'])
    addMessage(
      store,
      threadId,
      'assistant',
      'The selected model has no endpoint that supports image input. Choose an image-capable model in the composer and Resend, or use Resend without image on your prompt.',
    )
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    assert.ok(document.querySelector('.msg-image-input-unsupported'))
    assert.equal(
      document.querySelector('.msg-resend-without-images')?.textContent,
      'Resend without image',
    )
  })
})
