import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { KnowledgeNote } from '../../main/services/storage/knowledge-store.ts'
import type { PromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { mountConversation } from './conversation.ts'
import { mountConversationSearch, closeConversationSearch } from './conversation-search.ts'
import { registerPromptAttachments } from '../attachments/prompt-attachments.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// Right-click support for the transcript itself (#2471): a text selection
// offers quoting, filing to the roadmap and searching; a bare click on a
// message with nothing selected still offers to copy it.

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function installClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  })
}

function noopAttachmentHandlers(
  overrides: Partial<PromptAttachmentHandlers> = {},
): PromptAttachmentHandlers {
  const base: PromptAttachmentHandlers = {
    attachFile: () => {},
    attachTextBlock: () => {},
    quoteText: () => {},
    attachImage: () => {},
    attachVideo: () => Promise.resolve(),
    attachArchive: () => Promise.resolve(),
  }
  return { ...base, ...overrides }
}

/** Select `text` inside `container`'s single text node and dispatch a contextmenu at it. */
function rightClickSelection(container: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const value = node.nodeValue ?? ''
    const at = value.indexOf(text)
    if (at !== -1) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      const sel = document.getSelection()
      assert.ok(sel)
      sel.removeAllRanges()
      sel.addRange(range)
      node.parentElement?.dispatchEvent(
        new window.MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      )
      return
    }
    node = walker.nextNode()
  }
  assert.fail(`text "${text}" not found under container`)
}

function fakeRoadmapNote(id: string, prompt: string): KnowledgeNote {
  const now = new Date().toISOString()
  return {
    id,
    type: 'roadmap',
    title: prompt,
    body: prompt,
    tags: [],
    status: 'ready',
    fields: {},
    createdAt: now,
    updatedAt: now,
    file: `/knowledge/roadmap/${id}.md`,
  }
}

function contextMenuLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item')).map(
    (b) => b.textContent,
  )
}

function clickMenuItem(label: string): void {
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item')).find(
    (b) => b.textContent === label,
  )
  assert.ok(item, `menu item "${label}" is present`)
  item.click()
}

afterEach(() => {
  dismissContextMenu()
  closeConversationSearch()
  document.body.replaceChildren()
})

describe('transcript context menu — with a text selection', () => {
  it('offers Quote in reply, Add to roadmap, Search and Copy, in that order', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Selected text for quoting lives here.')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())

    const body = host.querySelector<HTMLElement>('.message-body')
    assert.ok(body)
    rightClickSelection(body, 'text for quoting')

    assert.deepEqual(contextMenuLabels(), ['Quote in reply', 'Add to roadmap', 'Search', 'Copy'])
  })

  it('does not open a menu on a plain click elsewhere in the transcript', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'nothing selected here')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())

    const list = host.querySelector<HTMLElement>('.messages-list')
    assert.ok(list)
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    list.dispatchEvent(event)

    assert.equal(event.defaultPrevented, false, 'blank space falls through to the platform menu')
    assert.equal(document.querySelector('.context-menu'), null)
  })

  it('"Quote in reply" inserts the selection as a blockquote and focuses the composer', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Selected text for quoting lives here.')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())

    let quoted: string | null = null
    let focused = false
    const unregister = registerPromptAttachments(
      noopAttachmentHandlers({
        quoteText: (content) => {
          quoted = content
        },
        focusComposer: () => {
          focused = true
        },
      }),
    )
    try {
      const body = host.querySelector<HTMLElement>('.message-body')
      assert.ok(body)
      rightClickSelection(body, 'text for quoting')
      clickMenuItem('Quote in reply')

      assert.equal(quoted, 'text for quoting')
      assert.equal(focused, true)
    } finally {
      unregister()
    }
  })

  it('"Add to roadmap" creates a roadmap item and links the active thread', async () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Selected text for quoting lives here.')
    const host = document.createElement('div')
    document.body.append(host)

    const created: string[] = []
    const linked: { id: string; threadId: string }[] = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      roadmap: {
        ...base.roadmap,
        create: (prompt) => {
          created.push(prompt)
          return Promise.resolve(fakeRoadmapNote('roadmap-1', prompt))
        },
        setThread: (id, tid) => {
          linked.push({ id, threadId: tid })
          return Promise.resolve(null)
        },
      },
    }
    mountConversation(host, store, api)

    const body = host.querySelector<HTMLElement>('.message-body')
    assert.ok(body)
    rightClickSelection(body, 'text for quoting')
    clickMenuItem('Add to roadmap')
    await tick()

    assert.deepEqual(created, ['text for quoting'])
    assert.deepEqual(linked, [{ id: 'roadmap-1', threadId }])
    const toast = document.querySelector('.toast-info')
    assert.equal(toast?.textContent, 'Added to roadmap')
  })

  it('"Search" opens the find bar prefilled with the selection', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Selected text for quoting lives here.')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())
    mountConversationSearch(host)

    const body = host.querySelector<HTMLElement>('.message-body')
    assert.ok(body)
    rightClickSelection(body, 'text for quoting')
    clickMenuItem('Search')

    const bar = document.querySelector<HTMLElement>('.chat-search')
    const input = document.querySelector<HTMLInputElement>('.chat-search-input')
    assert.equal(bar?.hidden, false)
    assert.equal(input?.value, 'text for quoting')
  })

  it('"Copy" copies the selected text', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Selected text for quoting lives here.')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())

    const copied: string[] = []
    installClipboard((text) => {
      copied.push(text)
      return Promise.resolve()
    })

    const body = host.querySelector<HTMLElement>('.message-body')
    assert.ok(body)
    rightClickSelection(body, 'text for quoting')
    clickMenuItem('Copy')

    assert.deepEqual(copied, ['text for quoting'])
  })
})

describe('transcript context menu — with no selection', () => {
  it('offers only Copy message for the message under the cursor', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Whole message body.')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())

    const msgEl = host.querySelector<HTMLElement>('.msg[data-message-id]')
    assert.ok(msgEl)
    document.getSelection()?.removeAllRanges()
    msgEl.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    assert.deepEqual(contextMenuLabels(), ['Copy message'])
  })

  it('"Copy message" copies that message\'s full text', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'assistant', 'Whole message body.')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())

    const copied: string[] = []
    installClipboard((text) => {
      copied.push(text)
      return Promise.resolve()
    })

    const msgEl = host.querySelector<HTMLElement>('.msg[data-message-id]')
    assert.ok(msgEl)
    document.getSelection()?.removeAllRanges()
    msgEl.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    clickMenuItem('Copy message')

    assert.deepEqual(copied, ['Whole message body.'])
  })
})
