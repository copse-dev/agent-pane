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

  it('docks both controls in the reserved row, outside the transcript scroller', () => {
    const { host, list, first, back } = fixture()
    scroll(list, 935)
    const row = host.querySelector('.conversation-navigation')
    assert.ok(row)
    // Neither control can cover transcript text: they are not inside the
    // scrolling area, and the label reveals before the return action.
    assert.equal(row.childElementCount, 2)
    // Compare identities, not elements: a failure would inspect the whole DOM.
    assert.ok(row.children[0] === first, 'First prompt comes first')
    assert.ok(row.children[1] === back, 'the return action follows it')
    assert.equal(host.querySelector('.conversation-scroll')?.contains(first), false)
  })

  it('reserves the pinned prompt band as scroll padding only while it is stuck', () => {
    const callbacks: Array<() => void> = []
    class CapturingResizeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    // The DOM shim has no ResizeObserver; capture the view's callbacks instead.
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: CapturingResizeObserver,
    })
    let list: HTMLElement
    try {
      list = fixture().list
    } finally {
      if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous)
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
    const prompts = list.querySelectorAll<HTMLElement>('.msg-user')
    const latest = prompts[prompts.length - 1]
    const before = latest?.previousElementSibling
    assert.ok(latest && before instanceof HTMLElement)
    list.style.paddingTop = '16px'
    list.style.rowGap = '12px'
    latest.style.position = 'sticky'
    latest.style.top = '-16px'
    latest.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 600, 58.4)
    const sync = (previousBottom: number): void => {
      before.getBoundingClientRect = (): DOMRect => new DOMRect(0, previousBottom - 100, 600, 100)
      for (const callback of callbacks) callback()
    }
    // Its place in the flow has scrolled above the top: it is stuck, so
    // scrollIntoView and search hits land below the prompt and its row gap.
    sync(-100)
    assert.equal(list.style.scrollPaddingTop, '71px')
    // The prompt and the rows before it cancel the band through this variable.
    assert.equal(list.style.getPropertyValue('--sticky-prompt-band'), '71px')
    // Still in the flow lower down: no padding, or the browser's scroll anchor
    // would skip past the prompt and its own growth would push it into sticking.
    sync(200)
    assert.equal(list.style.scrollPaddingTop, '')
    // A narrow pane returns the prompt to the flow: nothing to clear.
    latest.style.position = 'relative'
    sync(-100)
    assert.equal(list.style.scrollPaddingTop, '')
    assert.equal(list.style.getPropertyValue('--sticky-prompt-band'), '')
  })

  it('anchors the way back on the first row below the pinned band, not the tail inside it', () => {
    const { list, first, back } = fixture()
    // A latest prompt 138px tall stuck under 16px of list padding with a 12px
    // gap covers a 150px band.
    const prompts = list.querySelectorAll<HTMLElement>('.msg-user')
    const latest = prompts[prompts.length - 1]
    assert.ok(latest)
    list.style.paddingTop = '16px'
    list.style.rowGap = '12px'
    latest.style.position = 'sticky'
    latest.style.top = '-16px'
    latest.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 600, 138)
    // Stuck: the row before it has scrolled above the top.
    const before = latest.previousElementSibling
    assert.ok(before instanceof HTMLElement)
    before.getBoundingClientRect = (): DOMRect => new DOMRect(0, -200, 600, 100)
    // Rows are 100px tall from the list top. At 935, row 9 ends 65px down,
    // inside the band; row 10 is the first readable row.
    scroll(list, 935)
    first.click()
    // While away, content above row 10 grows by 30px (a disclosure opening).
    const rows = list.querySelectorAll<HTMLElement>('.msg')
    const row10 = rows[10]
    assert.ok(row10)
    row10.getBoundingClientRect = (): DOMRect => new DOMRect(0, 1_030 - list.scrollTop, 600, 100)
    back.click()
    // Row 10 is back where it was; anchoring on row 9 would have left it 30px low.
    assert.equal(list.scrollTop, 965)
  })
})
