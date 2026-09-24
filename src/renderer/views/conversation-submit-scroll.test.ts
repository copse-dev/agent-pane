import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// On submit, appendMessageEl used to call plain scrollToBottom(true), which
// flushes the transcript's bottom edge against the viewport. That is right
// for a short prompt, but for one taller than the visible list it hides the
// prompt's own start — the reader only ever sees its tail (#2457). happy-dom
// has no layout engine, so this pins the fix's rect math (scrollUserPromptInto
// View in conversation.ts) against a synthetic geometry, the same way
// conversation-newest-first-backfill.test.ts stubs scrollHeight/clientHeight.

function fakeApi(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: {
      ...base['agent'],
      run: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    },
  } satisfies ApiClient
}

const CLIENT_HEIGHT = 300
const FILLER_HEIGHT = 80
const LIST_WIDTH = 800

afterEach(() => {
  document.body.replaceChildren()
  // getBoundingClientRect is an own property of Element.prototype, not
  // HTMLElement.prototype (see installSyntheticGeometry below), so deleting
  // the shadowing copy this file installs on HTMLElement.prototype falls
  // through the chain to the real implementation — no saved reference needed.
  Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
})

/**
 * Give `list` a synthetic scrollable geometry: every `.msg-user`/
 * `.msg-assistant` direct child gets a fixed height (the *newest* user row
 * gets `newPromptHeight` instead), stacked top to bottom exactly like real
 * layout would, with `scrollTop` clamped to `[0, scrollHeight - clientHeight]`
 * the way a real browser clamps it (happy-dom does not — see
 * conversation-newest-first-backfill.test.ts's own note on this).
 */
function installSyntheticGeometry(list: HTMLElement, newPromptHeight: number): void {
  function heightOf(el: HTMLElement): number {
    if (el.classList.contains('msg-user')) {
      const users = Array.from(list.querySelectorAll<HTMLElement>(':scope > .msg-user'))
      return users.at(-1) === el ? newPromptHeight : FILLER_HEIGHT
    }
    if (el.classList.contains('msg-assistant')) return FILLER_HEIGHT
    return 0
  }
  function contentTop(el: HTMLElement): number {
    let top = 0
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib instanceof HTMLElement) top += heightOf(sib)
    }
    return top
  }
  function totalHeight(): number {
    let total = 0
    for (const child of Array.from(list.children)) {
      if (child instanceof HTMLElement) total += heightOf(child)
    }
    return total
  }

  let scrollTopValue = 0
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollHeight: { configurable: true, get: () => Math.max(totalHeight(), CLIENT_HEIGHT) },
    scrollTop: {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number): void => {
        const max = Math.max(0, totalHeight() - CLIENT_HEIGHT)
        scrollTopValue = Math.min(Math.max(value, 0), max)
      },
    },
  })
  list.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, LIST_WIDTH, CLIENT_HEIGHT)
  // Shadows Element.prototype's own getBoundingClientRect for every element;
  // afterEach deletes this own property to fall back to the real one.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this.parentElement === list) {
      return new DOMRect(0, contentTop(this) - list.scrollTop, LIST_WIDTH, heightOf(this))
    }
    return Element.prototype.getBoundingClientRect.call(this)
  }
}

function mountWithFiller(): {
  list: HTMLElement
  threadId: string
  store: ReturnType<typeof createStore>
} {
  const store = createStore()
  const threadId = createThread(store)
  for (let i = 0; i < 6; i++) {
    addMessage(store, threadId, i % 2 === 0 ? 'user' : 'assistant', `filler message ${String(i)}`)
  }
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  const list = host.querySelector<HTMLElement>('.messages-list')
  assert.ok(list, 'expected the mounted conversation to render its messages list')
  return { list, threadId, store }
}

describe('scroll the transcript to the submitted prompt (#2457)', () => {
  it('keeps a short prompt fully visible after submit', () => {
    const { list, threadId, store } = mountWithFiller()
    // Shorter than the pinned viewport — this is the case that already worked
    // before the fix, and must keep working.
    installSyntheticGeometry(list, 40)

    addMessage(store, threadId, 'user', 'short new prompt')

    const last = Array.from(list.querySelectorAll<HTMLElement>('.msg-user')).at(-1)
    assert.ok(last, 'expected the submitted prompt to render')
    const rect = last.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    assert.ok(
      rect.top >= listRect.top - 0.5,
      `expected the prompt's top to be visible, got top=${String(rect.top)} vs list top=${String(listRect.top)}`,
    )
    assert.ok(
      rect.bottom <= listRect.bottom + 0.5,
      `expected the prompt's bottom to be visible, got bottom=${String(rect.bottom)} vs list bottom=${String(listRect.bottom)}`,
    )
  })

  it('shows the start of a prompt taller than the visible list, not just its tail', () => {
    const { list, threadId, store } = mountWithFiller()
    // Taller than the pinned viewport (300px) — plain scrollToBottom(true)
    // flushes this row's *bottom* against the list, which pushes its top well
    // above the visible area. This is #2457's repro.
    installSyntheticGeometry(list, 500)

    addMessage(store, threadId, 'user', 'tall new prompt')

    const last = Array.from(list.querySelectorAll<HTMLElement>('.msg-user')).at(-1)
    assert.ok(last, 'expected the submitted prompt to render')
    const rect = last.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    assert.ok(
      rect.top >= listRect.top - 0.5,
      `expected the prompt's start to stay visible instead of being scrolled off, got top=${String(rect.top)} vs list top=${String(listRect.top)}`,
    )
  })
})
