import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  appendAcpContentBlock,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
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

  it('keeps tool-result images after a card that becomes a collapsed rollup', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      images: [
        {
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
          name: 'generated-concept.png',
        },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    const initialCard = message.querySelector<HTMLDetailsElement>(':scope > .tool-card')
    const initialImages = message.querySelector<HTMLElement>(':scope > .tool-result-images')
    assert.ok(initialCard)
    assert.ok(initialImages)
    assert.strictEqual(initialCard.nextElementSibling, initialImages)

    addToolCall(store, messageId, {
      id: 'tc-done-2',
      name: 'read_file',
      args: { path: 'notes.md' },
      status: 'done',
      result: 'notes',
    })

    const rollup = message.querySelector<HTMLDetailsElement>(':scope > .tool-card-rollup')
    const images = message.querySelector<HTMLElement>(':scope > .tool-result-images')
    const image = images?.querySelector<HTMLImageElement>('.tool-result-image')
    assert.ok(rollup)
    assert.equal(rollup.open, false)
    assert.ok(images, 'tool-result images render outside the collapsed rollup')
    assert.equal(rollup.contains(images), false)
    assert.strictEqual(rollup.nextElementSibling, images)
    assert.ok(image)
    assert.equal(image.alt, 'generated-concept.png')
    assert.equal(image.getAttribute('role'), 'button')
    assert.equal(image.getAttribute('aria-label'), 'Expand generated-concept.png')
  })

  it('previews a screenshot-kind tool image inline at reading size', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      images: [
        {
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
          name: 'generated-concept.png',
          kind: 'screenshot',
        },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    const preview = message.querySelector<HTMLElement>(':scope .tool-result-preview')
    assert.ok(preview, 'a screenshot-kind image renders as an inline preview figure')
    const image = preview.querySelector<HTMLImageElement>('.tool-result-preview-image')
    assert.ok(image)
    assert.equal(image.alt, 'generated-concept.png')
    assert.equal(image.getAttribute('role'), 'button')
    assert.equal(image.getAttribute('aria-label'), 'Expand generated-concept.png')
    assert.equal(
      preview.querySelector('.tool-result-preview-caption')?.textContent,
      'generated-concept.png',
    )
    assert.equal(
      message.querySelector('.tool-result-image'),
      null,
      'a previewed image does not also render as a thumbnail',
    )
  })

  it('keeps frame batches as thumbnails when no image is screenshot-kind', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      images: [
        { dataUrl: 'data:image/png;base64,ZnJhbWUtMQ==', name: 'frame-1.png', kind: 'frames' },
        { dataUrl: 'data:image/png;base64,ZnJhbWUtMg==', name: 'frame-2.png', kind: 'frames' },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    assert.equal(message.querySelector('.tool-result-preview'), null)
    assert.equal(message.querySelectorAll('.tool-result-image').length, 2)
  })

  it('renders rich ACP tool content outside the card and removes it on replacement', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      ...doneCall,
      id: 'tc-rich',
      result: null,
      images: [
        {
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
          name: 'concept.png',
          kind: 'screenshot',
        },
      ],
      content: [
        {
          type: 'content',
          content: {
            type: 'image',
            dataUrl: 'data:image/png;base64,aW1hZ2U=',
            mimeType: 'image/png',
            uri: 'concept.png',
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'https://example.test/report',
            name: 'report',
            title: 'Open report',
          },
        },
        { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
        { type: 'terminal', terminalId: 'terminal-1' },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    const card = message?.querySelector<HTMLElement>(':scope > .tool-card')
    const rich = message?.querySelector<HTMLElement>(':scope > .tool-result-content')
    assert.ok(card)
    assert.ok(rich)
    assert.equal(card.contains(rich), false)
    assert.strictEqual(card.nextElementSibling, rich)
    assert.equal(rich.querySelectorAll('.tool-result-preview-image').length, 1)
    assert.equal(
      rich.querySelector('a[href="https://example.test/report"]')?.textContent,
      'Open report',
    )
    assert.match(rich.querySelector('.acp-tool-diff')?.textContent ?? '', /src\/a\.ts/)
    assert.match(rich.querySelector('.acp-terminal-reference')?.textContent ?? '', /terminal-1/)

    updateToolCall(store, messageId, 'tc-rich', {
      result: 'replacement',
      images: [],
      content: [{ type: 'content', content: { type: 'text', text: 'replacement' } }],
    })
    assert.equal(
      message?.querySelector(':scope > .tool-result-content'),
      null,
      'text-only replacement clears every earlier rich block',
    )
  })

  it('renders ACP assistant media and embedded resources without Markdown data URLs', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Rich answer')
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'audio',
      dataUrl: 'data:audio/ogg;base64,YXVkaW8=',
      mimeType: 'audio/ogg',
    })
    appendAcpContentBlock(store, messageId, 'message', {
      type: 'resource',
      uri: 'file:///notes.txt',
      mimeType: 'text/plain',
      text: 'embedded notes',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const message = host.querySelector(`[data-message-id="${messageId}"]`)
    assert.ok(message)
    assert.ok(message.querySelector('audio[src^="data:audio/ogg;base64,"]'))
    assert.equal(message.querySelector('.acp-resource-text')?.textContent, 'embedded notes')
    assert.doesNotMatch(message.querySelector('.message-text')?.innerHTML ?? '', /base64/)
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

  it('builds the body when a running card reveals after the delay', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, runningCall)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-running-1"]')
    assert.ok(card)
    assert.equal(card.open, false, 'a fast tool should remain compact initially')
    await delay(350)
    assert.equal(card.open, true, 'a running tool card auto-expands')
    assert.ok(card.querySelector('.tool-args'), 'expected the args body to already be built')
  })

  it('does not claim a no-argument tool has no details while it is still running', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, {
      id: 'tc-running-empty',
      name: 'MCP: tool',
      args: {},
      status: 'running',
      result: null,
      resultFormat: 'markdown',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-running-empty"]')
    assert.ok(card)
    await delay(350)
    assert.equal(card.open, true)
    assert.equal(Boolean(card.querySelector('.tool-result-empty')), false)
  })

  it('shows an empty state when an MCP card has no arguments or result', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', 'Working…')
    addToolCall(store, messageId, {
      id: 'tc-mcp-empty-1',
      name: 'MCP: tool',
      args: {},
      status: 'done',
      result: '',
      resultFormat: 'markdown',
    })
    addToolCall(store, messageId, {
      id: 'tc-mcp-empty-2',
      name: 'MCP: tool',
      args: {},
      status: 'done',
      result: '',
      resultFormat: 'markdown',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const rollup = host.querySelector<HTMLDetailsElement>('.tool-card-rollup')
    assert.ok(rollup, 'multiple MCP calls should render inside a turn rollup')
    rollup.open = true

    const card = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-mcp-empty-1"]')
    assert.ok(card)
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))
    card.open = true
    await Promise.resolve()

    const emptyState = card.querySelector('.tool-result-empty')
    assert.ok(emptyState, 'an open card with no payload should visibly reveal a body')
    assert.match(emptyState.textContent, /No tool details were provided/)

    updateToolCall(store, messageId, 'tc-mcp-empty-1', { status: 'done' })
    const reconciled = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-mcp-empty-1"]')
    assert.strictEqual(reconciled, card, 'an unchanged empty card should be reused')
    assert.equal(
      reconciled.open,
      true,
      'the empty card should remain expanded after reconciliation',
    )
  })

  it('builds the body for a card kept open across a reconcile tick', async () => {
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
    await Promise.resolve()
    assert.ok(card.querySelector('.tool-result'), 'sanity: body built after opening')

    // Changing the tool call's own result patches the existing disclosure shell
    // and preserves the user's expansion while refreshing its lazy body.
    updateToolCall(store, messageId, 'tc-done-1', { result: '# Copse (updated)' })

    const reconciled = host.querySelector<HTMLDetailsElement>('[data-tool-id="tc-done-1"]')
    assert.ok(reconciled)
    assert.strictEqual(reconciled, card, 'the disclosure shell should be reused')
    assert.equal(reconciled.open, true, 'expansion survives the reconcile')
    const resultAfter = reconciled.querySelector('.tool-result')
    assert.ok(
      resultAfter,
      'a card restored open must have its body rendered, not just the flag flipped',
    )
    assert.match(resultAfter.textContent, /# Copse \(updated\)/)
  })
})
