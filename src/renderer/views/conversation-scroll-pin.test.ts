import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// When content above the bottom shrinks (a finished turn's disclosures
// compacting), the browser clamps scrollTop down to the new bottom and fires a
// scroll event. That is not the reader scrolling up: they are still at the
// bottom and the transcript should keep following. happy-dom has no layout
// engine, so the list gets a synthetic geometry whose scrollTop clamps the way
// a browser's does (see conversation-submit-scroll.test.ts).

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
const ROW_HEIGHT = 80

afterEach(() => {
  document.body.replaceChildren()
})

/** A list whose rows are ROW_HEIGHT tall, plus `extra` px that the test can shrink. */
function installGeometry(list: HTMLElement): { setExtra: (px: number) => void; max: () => number } {
  let extra = 0
  let scrollTopValue = 0
  const contentHeight = (): number =>
    list.querySelectorAll(':scope > .msg-user, :scope > .msg-assistant').length * ROW_HEIGHT + extra
  const max = (): number => Math.max(0, contentHeight() - CLIENT_HEIGHT)
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollHeight: { configurable: true, get: () => Math.max(contentHeight(), CLIENT_HEIGHT) },
    scrollTop: {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number): void => {
        scrollTopValue = Math.min(Math.max(value, 0), max())
      },
    },
  })
  return {
    setExtra: (px: number): void => {
      extra = px
      // A browser clamps scrollTop when scrollHeight drops below it and
      // reports the move with a scroll event.
      const before = scrollTopValue
      scrollTopValue = Math.min(scrollTopValue, max())
      if (scrollTopValue !== before) list.dispatchEvent(new Event('scroll'))
    },
    max,
  }
}

function mountAtBottom(): {
  list: HTMLElement
  threadId: string
  store: ReturnType<typeof createStore>
  geometry: ReturnType<typeof installGeometry>
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
  const geometry = installGeometry(list)
  geometry.setExtra(400)
  list.scrollTop = geometry.max()
  list.dispatchEvent(new Event('scroll'))
  return { list, threadId, store, geometry }
}

describe('transcript bottom pinning', () => {
  it('keeps following new output after content above the bottom shrinks', () => {
    const { list, threadId, store, geometry } = mountAtBottom()

    // A disclosure collapses: the browser clamps scrollTop down to the new bottom.
    geometry.setExtra(0)
    assert.equal(list.scrollTop, geometry.max(), 'the clamp leaves the view at the bottom')

    addMessage(store, threadId, 'assistant', 'next reply')

    assert.equal(
      list.scrollTop,
      geometry.max(),
      'a layout clamp is not the reader scrolling up, so the new reply should be followed',
    )
  })

  it('still stops following when the reader scrolls up', () => {
    const { list, threadId, store, geometry } = mountAtBottom()

    const readingAt = geometry.max() - 120
    list.scrollTop = readingAt
    list.dispatchEvent(new Event('scroll'))

    addMessage(store, threadId, 'assistant', 'next reply')

    assert.equal(list.scrollTop, readingAt, 'a reader who scrolled up keeps their place')
  })
})
