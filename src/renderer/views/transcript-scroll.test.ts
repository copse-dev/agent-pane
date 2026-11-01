import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STREAM_PAINT_EVENT } from '../markdown/message-markdown.ts'
import {
  createTranscriptScroll,
  scrollIntoTranscriptView,
  type TranscriptScroll,
} from './transcript-scroll.ts'

// Component tests for the transcript scroll extracted from mountConversation.
// happy-dom has no layout engine, so the list gets a synthetic one: rows stack
// at the heights the test sets, scrollTop clamps like a browser's, and each
// row's rect follows the scroll offset. Scroll events are dispatched by hand,
// as the browser would after a scrollTop write that moved the view.

const CLIENT_HEIGHT = 300

interface Fixture {
  list: HTMLElement
  button: HTMLElement
  scroll: TranscriptScroll
  rows: HTMLElement[]
  returnsToLiveEnd: () => number
  stickySyncs: boolean[]
  max: () => number
  /** Set scrollTop as the reader would, and deliver the scroll event. */
  readerScrollTo: (top: number) => void
}

function rowHeight(row: Element): number {
  return Number(row instanceof HTMLElement ? (row.dataset['h'] ?? '0') : '0')
}

function mount(heights: readonly number[]): Fixture {
  const list = document.createElement('div')
  const button = document.createElement('button')
  document.body.append(list, button)
  const rows = heights.map((h, i) => {
    const row = document.createElement('div')
    row.className = 'msg'
    row.dataset['h'] = String(h)
    row.dataset['i'] = String(i)
    list.append(row)
    return row
  })
  let scrollTopValue = 0
  const contentHeight = (): number =>
    [...list.children].reduce((sum, row) => sum + rowHeight(row), 0)
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
  list.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 400, CLIENT_HEIGHT)
  for (const row of rows) {
    row.getBoundingClientRect = (): DOMRect => {
      let top = -scrollTopValue
      for (const child of list.children) {
        if (child === row) break
        top += rowHeight(child)
      }
      return new DOMRect(0, top, 400, rowHeight(row))
    }
  }
  let returns = 0
  const stickySyncs: boolean[] = []
  const scroll = createTranscriptScroll({
    list,
    scrollToBottomBtn: button,
    scrollToBottomLabel: document.createElement('span'),
    // First prompt navigation is covered in conversation-first-prompt.test.ts.
    firstPromptBtn: document.createElement('button'),
    firstPromptId: () => null,
    stickyPromptBand: () => 0,
    syncStickyImagePreview: (release) => {
      stickySyncs.push(release)
    },
    onReturnToLiveEnd: () => {
      returns++
    },
  })
  return {
    list,
    button,
    scroll,
    rows,
    returnsToLiveEnd: () => returns,
    stickySyncs,
    max,
    readerScrollTo: (top): void => {
      list.scrollTop = top
      list.dispatchEvent(new Event('scroll'))
    },
  }
}

let realNow: () => number
let now = 1_000_000

beforeEach(() => {
  realNow = Date.now
  now = 1_000_000
  Date.now = (): number => now
})

afterEach(() => {
  Date.now = realNow
  document.body.replaceChildren()
})

describe('transcript scroll (component)', () => {
  it('reads its own scroll echo as its own, and the reader’s next scroll-up as the reader’s', () => {
    const f = mount([200, 200, 200])
    f.scroll.scrollToBottom(true)
    assert.equal(f.list.scrollTop, f.max())
    assert.equal(f.returnsToLiveEnd(), 1)
    // The browser echoes the programmatic write; it must not unpin.
    f.list.dispatchEvent(new Event('scroll'))
    assert.equal(f.scroll.isPinnedToBottom(), true)
    assert.equal(f.button.hidden, true)

    f.readerScrollTo(100)
    assert.equal(f.scroll.isPinnedToBottom(), false)
    assert.equal(f.button.hidden, false)
    assert.equal(f.stickySyncs.at(-1), true, 'a genuine scroll-up may release the sticky preview')
    // Unpinned, an unforced follow leaves the reader where they are.
    f.scroll.scrollToBottom()
    assert.equal(f.list.scrollTop, 100)
  })

  it('keeps the pin through a clamp when content above the bottom shrinks', () => {
    const f = mount([200, 200, 200])
    f.scroll.scrollToBottom(true)
    f.list.dispatchEvent(new Event('scroll'))
    // A disclosure compacts: the browser clamps scrollTop to the new bottom.
    const last = f.rows[2]
    assert.ok(last)
    last.dataset['h'] = '50'
    f.readerScrollTo(f.list.scrollTop)
    assert.equal(f.scroll.isPinnedToBottom(), true)
    assert.equal(f.stickySyncs.at(-1), false, 'a clamp never releases the sticky preview')
  })

  it('re-pins when the reader scrolls back near the bottom and resumes deferred work', () => {
    const f = mount([200, 200, 200])
    f.scroll.scrollToBottom(true)
    f.list.dispatchEvent(new Event('scroll'))
    f.readerScrollTo(50)
    assert.equal(f.scroll.isPinnedToBottom(), false)
    const before = f.returnsToLiveEnd()
    f.readerScrollTo(f.max() - 10)
    assert.equal(f.scroll.isPinnedToBottom(), true)
    assert.equal(f.returnsToLiveEnd(), before + 1)
  })

  it('unpins on a wheel-up, unless a nested scroller takes it', () => {
    const f = mount([200, 200, 200])
    f.scroll.scrollToBottom(true)
    const row = f.rows[1]
    assert.ok(row)
    const code = document.createElement('pre')
    code.style.overflowY = 'auto'
    Object.defineProperties(code, {
      scrollTop: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
    })
    row.append(code)
    code.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -20, bubbles: true }))
    assert.equal(f.scroll.isPinnedToBottom(), true)

    row.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -20, bubbles: true }))
    assert.equal(f.scroll.isPinnedToBottom(), false)
    assert.equal(f.button.hidden, true, 'the view has not moved yet, so the button stays hidden')
  })

  it('jump-to-bottom button follows the live end again', () => {
    const f = mount([200, 200, 200])
    f.readerScrollTo(0)
    f.scroll.unpin()
    f.button.click()
    assert.equal(f.list.scrollTop, f.max())
    assert.equal(f.scroll.isPinnedToBottom(), true)
    assert.equal(f.returnsToLiveEnd(), 1)
  })

  it('holds the first visible item in place while content above it grows', () => {
    const f = mount([200, 200, 200, 200])
    readAwayFromBottom(f, 250)
    const anchorRow = f.rows[1]
    assert.ok(anchorRow)
    const topBefore = anchorRow.getBoundingClientRect().top
    f.scroll.keepReadingPosition(() => {
      const first = f.rows[0]
      assert.ok(first)
      first.dataset['h'] = '320'
    })
    assert.ok(Math.abs(anchorRow.getBoundingClientRect().top - topBefore) <= 0.5)
    assert.equal(f.list.scrollTop, 370)
    // Our correction echoes back; it must not read as the reader scrolling.
    f.list.dispatchEvent(new Event('scroll'))
    assert.equal(f.scroll.isPinnedToBottom(), false)
  })

  it('follows the live end instead when pinned', () => {
    const f = mount([200, 200])
    f.scroll.scrollToBottom(true)
    now += 1000
    f.scroll.keepReadingPosition(() => {
      const extra = document.createElement('div')
      extra.dataset['h'] = '400'
      f.list.append(extra)
    })
    assert.equal(f.list.scrollTop, f.max())
  })

  it('falls back to the old scrollTop when the anchor was removed', () => {
    const f = mount([200, 200, 200, 200])
    readAwayFromBottom(f, 250)
    const anchor = f.scroll.captureReadingAnchor()
    assert.equal(anchor?.element, f.rows[1])
    f.rows[1]?.remove()
    f.list.scrollTop = 0
    f.scroll.restoreReadingAnchor(anchor, 250)
    assert.equal(f.list.scrollTop, 250)
  })

  it('shows the top of a prompt taller than the list, and stops following', () => {
    const f = mount([200, 500])
    f.scroll.scrollToBottom(true)
    const prompt = f.rows[1]
    assert.ok(prompt)
    f.scroll.scrollUserPromptIntoView(prompt)
    assert.equal(prompt.getBoundingClientRect().top, 0)
    assert.equal(f.scroll.isPinnedToBottom(), false)
  })

  it('a new thread starts pinned to its live end', () => {
    const f = mount([200, 200, 200])
    f.readerScrollTo(0)
    f.scroll.unpin()
    f.scroll.resetForThread()
    assert.equal(f.scroll.isPinnedToBottom(), true)
    f.scroll.scrollToBottom()
    assert.equal(f.list.scrollTop, f.max())
  })

  it('glides to the bottom after a stream paint while pinned, and not once unpinned', async () => {
    const f = mount([200, 200])
    f.scroll.scrollToBottom(true)
    now += 1000
    const grown = f.rows[1]
    assert.ok(grown)
    grown.dataset['h'] = '600'
    f.rows[0]?.dispatchEvent(new CustomEvent(STREAM_PAINT_EVENT, { bubbles: true }))
    await waitFor(() => f.list.scrollTop === f.max())

    f.readerScrollTo(0)
    grown.dataset['h'] = '900'
    f.rows[0]?.dispatchEvent(new CustomEvent(STREAM_PAINT_EVENT, { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(f.list.scrollTop, 0)
  })
})

/** Follow the live end, then scroll up to `top` as the reader. */
function readAwayFromBottom(f: Fixture, top: number): void {
  f.scroll.scrollToBottom(true)
  f.list.dispatchEvent(new Event('scroll'))
  f.readerScrollTo(top)
  assert.equal(f.scroll.isPinnedToBottom(), false)
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  assert.ok(done(), 'condition not reached')
}

describe('scrollIntoTranscriptView', () => {
  it('applies the pinned band as scroll padding only for the call', () => {
    const list = document.createElement('div')
    list.className = 'messages-list'
    const row = document.createElement('div')
    list.append(row)
    document.body.append(list)
    const seen: string[] = []
    row.scrollIntoView = (): void => {
      seen.push(
        `${list.style.scrollPaddingTop}|${list.style.getPropertyValue('--sticky-prompt-scroll-band')}`,
      )
    }
    // No band: an ordinary scroll.
    scrollIntoTranscriptView(row, { block: 'center' })
    list.style.setProperty('--sticky-prompt-band', '71px')
    scrollIntoTranscriptView(row, { block: 'center' })
    assert.deepEqual(seen, ['|', '71px|71px'])
    // Standing padding would steer the browser's scroll anchor, and standing
    // negative margins would overshoot scrolls made without it: both restored.
    assert.equal(list.style.scrollPaddingTop, '')
    assert.equal(list.style.getPropertyValue('--sticky-prompt-scroll-band'), '')
    list.remove()
  })
})
