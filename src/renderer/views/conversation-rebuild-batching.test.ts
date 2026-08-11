import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// Rebuilding the transcript on a thread switch renders a window of the tail
// (INITIAL_RENDER_WINDOW) and backfills the rest. The label/action/scroll passes
// that follow an append are each O(thread length) or force a layout, so running
// them per message made a switch cost O(window × thread length). They are
// batched per render pass instead; these tests pin both halves of that — the DOM
// still comes out identical, and the cost no longer scales with thread length.

const MODEL_A = 'claude-sonnet-4-6'
const MODEL_B = 'gpt-5'

interface Mounted {
  store: AppStore
  host: HTMLElement
  unmount: () => void
}

/**
 * A thread of `turns` user/assistant pairs, the second half answered by a
 * different model so the multi-model label pass has real boundaries to place.
 */
function mountThread(turns: number): Mounted {
  const store = createStore()
  const threadId = createThread(store)
  for (let i = 0; i < turns; i++) {
    addMessage(store, threadId, 'user', `prompt ${String(i)}`)
    addMessage(store, threadId, 'assistant', `reply ${String(i)}`, undefined, undefined, {
      model: i < turns / 2 ? MODEL_A : MODEL_B,
    })
  }
  const host = document.createElement('div')
  document.body.append(host)
  const unmount = mountConversation(host, store, createFakeApi())
  return { store, host, unmount }
}

/**
 * Count `querySelector` calls issued by the blocking part of `run` — the work
 * that happens before the switch can paint. History older than the initial
 * window is filled in later frames, so `requestAnimationFrame` is stubbed out
 * for the measurement (the test DOM otherwise runs it synchronously and folds
 * the whole backfill, whose cost legitimately grows with thread length, into
 * the number).
 */
function countBlockingQuerySelectorCalls(run: () => void): number {
  // Property (not method) shape so the swap reads as a plain field assignment
  // and picks the modern `querySelector` signature rather than lib.dom's
  // deprecated tag-name overloads.
  const proto: { querySelector: (this: Element, selectors: string) => Element | null } =
    Element.prototype
  const originalQuery = proto.querySelector
  const originalRaf = globalThis.requestAnimationFrame
  let calls = 0
  proto.querySelector = function patched(this: Element, selectors: string): Element | null {
    calls++
    return originalQuery.call(this, selectors)
  }
  globalThis.requestAnimationFrame = (): number => 0
  try {
    run()
  } finally {
    proto.querySelector = originalQuery
    globalThis.requestAnimationFrame = originalRaf
  }
  return calls
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('conversation transcript rebuild', () => {
  it('labels model-segment boundaries across the rendered window', () => {
    const { store, host, unmount } = mountThread(30)
    store.emit('threads_changed')

    const labels = [...host.querySelectorAll('.message-model')].map((el) => el.textContent)
    // Both models are used, so labels show — but only where the model changes.
    // The window covers the tail, whose first rendered assistant message opens a
    // segment, and the MODEL_A → MODEL_B switch opens the other.
    assert.ok(labels.length >= 1, 'expected at least one model-segment label')
    assert.ok(
      labels.length <= 2,
      `expected at most two segment labels, got ${String(labels.length)}`,
    )
    assert.equal(new Set(labels).size, labels.length, 'segment labels should not repeat')

    unmount()
  })

  it('offers Resend on exactly one message after a rebuild', () => {
    const { store, host, unmount } = mountThread(30)
    store.emit('threads_changed')

    const visible = [...host.querySelectorAll<HTMLButtonElement>('.msg-resend')].filter(
      (button) => !button.hidden,
    )
    assert.equal(visible.length, 1, 'only the last resendable prompt keeps its Resend button')

    unmount()
  })

  it('does not scale rebuild DOM queries with thread length', () => {
    const small = mountThread(30)
    const smallCalls = countBlockingQuerySelectorCalls(() => {
      small.store.emit('threads_changed')
    })
    small.unmount()

    const large = mountThread(120)
    const largeCalls = countBlockingQuerySelectorCalls(() => {
      large.store.emit('threads_changed')
    })
    large.unmount()

    // A 4× longer thread renders the same tail window, so a rebuild should cost
    // about the same. The per-message passes this replaced made it cost 4× more.
    assert.ok(
      largeCalls < smallCalls * 2,
      `rebuild queries grew with thread length: ${String(smallCalls)} → ${String(largeCalls)}`,
    )
  })
})
