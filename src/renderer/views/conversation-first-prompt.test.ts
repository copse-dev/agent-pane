import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

let cleanup = (): void => {}
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function fixture(
  count = 97,
  roleAt = (index: number): 'user' | 'assistant' => (index % 2 === 0 ? 'user' : 'assistant'),
): {
  host: HTMLElement
  list: HTMLElement
  first: HTMLButtonElement
  back: HTMLButtonElement
  store: ReturnType<typeof createStore>
  threadId: string
} {
  const store = createStore()
  const threadId = createThread(store)
  for (let i = 0; i < count; i++) {
    addMessage(store, threadId, roleAt(i), `Message ${String(i)}`)
  }
  const host = document.createElement('div')
  document.body.append(host)
  cleanup = mountConversation(host, store, createFakeApi())
  const list = host.querySelector<HTMLElement>('.messages-list')
  const first = host.querySelector<HTMLButtonElement>('.conversation-first-prompt')
  const back = host.querySelector<HTMLButtonElement>('.scroll-to-bottom')
  assert.ok(list && first && back)
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => count * 100 },
    clientHeight: { configurable: true, get: () => 300 },
  })
  list.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 600, 300)
  Array.from(list.querySelectorAll<HTMLElement>('.msg')).forEach((message, index) => {
    message.getBoundingClientRect = (): DOMRect =>
      new DOMRect(0, index * 100 - list.scrollTop, 600, 100)
  })
  return { host, list, first, back, store, threadId }
}

function scroll(list: HTMLElement, position: number): void {
  list.scrollTop = position
  list.dispatchEvent(new Event('scroll'))
}

describe('first prompt navigation', () => {
  it('returns to a middle reading position instead of jumping to latest', () => {
    const { list, first, back } = fixture()
    scroll(list, 935)
    assert.equal(first.hidden, false)
    assert.equal(back.textContent, 'Back to latest')
    first.click()
    assert.equal(list.scrollTop, 0)
    assert.equal(first.hidden, true)
    assert.equal(back.textContent, 'Back to where you were')
    back.click()
    assert.equal(list.scrollTop, 935)
    assert.equal(back.textContent, 'Back to latest')
  })

  it('jumps to a sole prompt that sticks at the top while its answer is read', () => {
    const { list, first } = fixture(40, (index) => (index === 0 ? 'user' : 'assistant'))
    list.style.paddingTop = '16px'
    list.style.rowGap = '8px'
    const prompt = list.querySelector<HTMLElement>('.msg-user')
    assert.ok(prompt)
    // The latest human prompt sticks, so its box stays at the top however far
    // the list scrolls; here it is also the first prompt.
    prompt.style.position = 'sticky'
    prompt.getBoundingClientRect = (): DOMRect => new DOMRect(0, -16, 600, 100)
    scroll(list, 1_900)
    first.click()
    assert.equal(list.scrollTop, 16)
  })

  it('keeps the way back while a stream the reader scrolled down to glides on', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const { list, first, back } = fixture()
    scroll(list, 935)
    first.click()
    // Past the scroll-up debounce, the reader scrolls back to the live end by hand.
    t.mock.timers.tick(1_000)
    scroll(list, 9_400)
    // The answer grows, and frames now arrive one at a time as in a browser.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 12_000 })
    const frames: Array<() => void> = []
    t.mock.method(globalThis, 'requestAnimationFrame', (callback: () => void) =>
      frames.push(callback),
    )
    list.dispatchEvent(new CustomEvent('copse:stream-paint'))
    frames.shift()?.()
    assert.ok(list.scrollTop > 9_400, 'the stream follow glides toward the new end')
    assert.equal(back.hidden, false)
    assert.equal(back.textContent, 'Back to where you were')
  })

  it('hides navigation when the entire thread fits in the viewport', () => {
    const { list, first, back } = fixture(2)
    scroll(list, 0)
    assert.equal(first.hidden, true)
    assert.equal(back.hidden, true)
  })

  it('clears the old return destination when a new prompt is submitted', () => {
    const { list, first, back, store, threadId } = fixture()
    scroll(list, 935)
    first.click()
    addMessage(store, threadId, 'user', 'Continue with the change.')
    assert.equal(back.textContent, 'Back to latest')
  })

  it('clears the saved destination on thread switches', () => {
    const { list, first, back, store } = fixture()
    scroll(list, 935)
    first.click()
    createThread(store)
    assert.equal(back.textContent, 'Back to latest')
    assert.equal(first.hidden, true)
  })

  it('restores the numeric position if a same-thread rebuild replaces the anchor', () => {
    const { list, first, back, store } = fixture()
    scroll(list, 935)
    first.click()
    store.emit('threads_changed')
    back.click()
    assert.equal(list.scrollTop, 935)
  })
})
