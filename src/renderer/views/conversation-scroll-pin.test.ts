import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  setThreadStatus,
  switchThread,
} from '@shared/store/thread-helpers.ts'
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
    list.querySelectorAll(':scope > .msg-user, :scope > .msg-assistant').length * ROW_HEIGHT +
    (list.querySelector(':scope > .agent-activity:not([hidden])') ? 32 : 0) +
    extra
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
  it('retains compact previews through an upward reading-anchor correction', () => {
    const store = createStore({ conciseThreadsEnabled: false })
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'Earlier request')
    addMessage(store, threadId, 'assistant', 'Earlier reply', undefined, undefined, {
      model: 'claude-opus-5-5',
    })
    addMessage(store, threadId, 'user', 'Describe this image', ['data:image/png;base64,abc'])
    addMessage(store, threadId, 'assistant', 'Image description')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())
    const list = host.querySelector<HTMLElement>('.messages-list')
    const prompt = [...host.querySelectorAll<HTMLElement>('.msg-user')].at(-1)
    const previous = prompt?.previousElementSibling
    assert.ok(list && prompt && previous)
    list.style.paddingTop = '0px'
    list.style.rowGap = '0px'
    prompt.style.position = 'sticky'
    prompt.style.top = '0px'
    let top = 0
    let max = 600
    Object.defineProperties(list, {
      clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
      scrollHeight: { configurable: true, get: () => max + CLIENT_HEIGHT },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number): void => {
          top = Math.min(Math.max(value, 0), max)
        },
      },
    })
    list.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 500, CLIENT_HEIGHT)
    for (const message of list.querySelectorAll<HTMLElement>(':scope > .msg')) {
      message.getBoundingClientRect = (): DOMRect => new DOMRect(0, -500, 500, 80)
    }
    // Concise presentation removes 120px above the first visible row. The
    // conversation restores that row's viewport position by scrolling upward.
    previous.getBoundingClientRect = (): DOMRect =>
      new DOMRect(0, 490 - top - (previous.classList.contains('msg-concise') ? 120 : 0), 500, 80)
    prompt.getBoundingClientRect = (): DOMRect =>
      new DOMRect(0, 0, 500, prompt.classList.contains('is-preview-compact') ? 60 : 200)
    list.scrollTop = max
    list.dispatchEvent(new Event('scroll'))
    assert.ok(prompt.classList.contains('is-preview-compact'))

    // The preview's shrink clamps the list into its hysteresis band: natural
    // top 90px, below the sticky top but without enough space for a full image.
    max = 480
    list.scrollTop = max
    list.dispatchEvent(new Event('scroll'))
    assert.ok(prompt.classList.contains('is-preview-compact'))
    max = 1000
    const wheel = new Event('wheel', { bubbles: true })
    Object.defineProperty(wheel, 'deltaY', { value: -120 })
    list.dispatchEvent(wheel)
    store.setState({ conciseThreadsEnabled: true })
    store.emit('settings_changed')

    assert.equal(list.scrollTop, 360, 'the automatic correction preserves the reading anchor')
    assert.ok(prompt.classList.contains('is-preview-compact'), 'layout is not reader scroll intent')
    list.dispatchEvent(new Event('scroll')) // consume the programmatic echo
    list.scrollTop -= 10
    list.dispatchEvent(new Event('scroll'))
    assert.equal(
      prompt.classList.contains('is-preview-compact'),
      false,
      'reader scroll still expands',
    )
  })

  it('lands at the bottom when switching between threads with the same live activity', () => {
    const { list, threadId, store, geometry } = mountAtBottom()
    setThreadStatus(store, threadId, 'running')
    const otherId = createThread(store)
    for (let i = 0; i < 6; i++) {
      addMessage(store, otherId, i % 2 === 0 ? 'user' : 'assistant', `other message ${String(i)}`)
    }
    setThreadStatus(store, otherId, 'running')
    store.emit('agent_activity', otherId, 'Reasoning…')

    switchThread(store, threadId)

    assert.ok(list.querySelector(':scope > .agent-activity:not([hidden])'))
    assert.equal(
      list.scrollTop,
      geometry.max(),
      'the reattached activity row is part of the bottom',
    )
  })

  it('keeps the live activity row in view on a pinned same-thread rebuild', () => {
    const { list, threadId, store, geometry } = mountAtBottom()
    setThreadStatus(store, threadId, 'running')
    store.emit('agent_activity', threadId, 'Reasoning…')

    store.emit('threads_changed')

    assert.equal(list.scrollTop, geometry.max(), 'an unchanged activity label must not leave a gap')
  })

  it('preserves a reader’s position when rebuilding a running thread', () => {
    const { list, threadId, store, geometry } = mountAtBottom()
    setThreadStatus(store, threadId, 'running')
    store.emit('agent_activity', threadId, 'Reasoning…')
    const readingAt = geometry.max() - 120
    list.scrollTop = readingAt
    list.dispatchEvent(new Event('scroll'))

    store.emit('threads_changed')

    assert.equal(list.scrollTop, readingAt, 'rebuilding must not force a reader back to the bottom')
  })

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

  it('leaves a reader who scrolled up unpinned when a shrink clamps them onto the bottom', async () => {
    const { list, threadId, store, geometry } = mountAtBottom()

    // The reader scrolls up, away from the bottom.
    list.scrollTop = geometry.max() - 120
    list.dispatchEvent(new Event('scroll'))
    // Content collapses under them far enough that the browser clamps their
    // position onto the new bottom. That is layout, not a choice to follow.
    geometry.setExtra(0)
    const clampedAt = list.scrollTop
    assert.equal(clampedAt, geometry.max(), 'the clamp lands on the new bottom')

    // Past the scroll-up debounce, so only the pin state decides.
    await new Promise((resolve) => setTimeout(resolve, 200))
    addMessage(store, threadId, 'assistant', 'next reply')

    assert.equal(list.scrollTop, clampedAt, 'the clamp must not re-pin a reader who scrolled up')
  })

  it('still stops following when the reader scrolls up', () => {
    const { list, threadId, store, geometry } = mountAtBottom()

    const readingAt = geometry.max() - 120
    list.scrollTop = readingAt
    list.dispatchEvent(new Event('scroll'))

    addMessage(store, threadId, 'assistant', 'next reply')

    assert.equal(list.scrollTop, readingAt, 'a reader who scrolled up keeps their place')
  })

  it('keeps following when a wheel-up only scrolls a nested code block', () => {
    const { list, threadId, store, geometry } = mountAtBottom()
    // A long code block or tool output with its own scrollbar, scrolled down.
    const nested = document.createElement('pre')
    nested.style.overflowY = 'auto'
    Object.defineProperties(nested, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 400 },
      scrollTop: { configurable: true, get: () => 50 },
    })
    list.querySelector(':scope > .msg-assistant')?.append(nested)

    const wheel = new Event('wheel', { bubbles: true })
    Object.defineProperty(wheel, 'deltaY', { value: -120 })
    nested.dispatchEvent(wheel)
    addMessage(store, threadId, 'assistant', 'next reply')

    assert.equal(
      list.scrollTop,
      geometry.max(),
      'the code block took the wheel; the transcript never moved, so it keeps following',
    )
  })
})
