import { browser } from '@wdio/globals'

/** Consecutive identical reads that count as settled (each `SETTLE_POLL_MS` apart). */
const SETTLED_READS = 3
const SETTLE_POLL_MS = 50

/**
 * Wait until the transcript's scroll position, size and jump-to-bottom button
 * stop changing, with the button shown or hidden as `buttonVisible` says.
 * Replaces a fixed pause before a capture: the scroll handler, the stream
 * follow glide and late layout (fonts, disclosures) all land on their own
 * schedule, and a pause that is long enough on one host is short on another.
 */
export async function waitForTranscriptScrollSettled(buttonVisible: boolean): Promise<void> {
  let previous = ''
  let stableReads = 0
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(() => {
        const list = document.querySelector('.messages-list')
        const btn = document.querySelector('.scroll-to-bottom')
        if (!(list instanceof HTMLElement) || !(btn instanceof HTMLElement)) return null
        const rect = btn.getBoundingClientRect()
        return {
          visible: !btn.hidden && rect.width > 0,
          signature: [
            list.scrollTop,
            list.scrollHeight,
            list.clientHeight,
            btn.hidden,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
          ].join(','),
        }
      })
      if (!state || state.visible !== buttonVisible) {
        previous = ''
        stableReads = 0
        return false
      }
      stableReads = state.signature === previous ? stableReads + 1 : 1
      previous = state.signature
      return stableReads >= SETTLED_READS
    },
    {
      timeout: 10_000,
      interval: SETTLE_POLL_MS,
      timeoutMsg: `expected the transcript scroll to settle with scroll-to-bottom ${
        buttonVisible ? 'shown' : 'hidden'
      }`,
    },
  )
}

export interface TextOverlap {
  text: string
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Rendered transcript and queued-message text that the visible jump-to-bottom
 * button covers. Each text node's line boxes are clipped to the scrollport
 * that shows them, so text scrolled out of view does not count.
 */
export async function scrollToBottomTextOverlaps(): Promise<TextOverlap[]> {
  return browser.execute(() => {
    const btn = document.querySelector('.scroll-to-bottom')
    if (!(btn instanceof HTMLElement) || btn.hidden) throw new Error('scroll-to-bottom not shown')
    const button = btn.getBoundingClientRect()
    const overlaps: {
      text: string
      rect: { x: number; y: number; width: number; height: number }
    }[] = []
    for (const scroller of document.querySelectorAll('.messages-list, .conversation-queued')) {
      if (!(scroller instanceof HTMLElement) || scroller.hidden) continue
      const port = scroller.getBoundingClientRect()
      const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        if (text.trim() === '') continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const line of range.getClientRects()) {
          const top = Math.max(line.top, port.top, button.top)
          const bottom = Math.min(line.bottom, port.bottom, button.bottom)
          const left = Math.max(line.left, port.left, button.left)
          const right = Math.min(line.right, port.right, button.right)
          if (bottom - top > 0.5 && right - left > 0.5) {
            overlaps.push({
              text: text.trim().slice(0, 80),
              rect: {
                x: line.x,
                y: line.y,
                width: line.width,
                height: line.height,
              },
            })
          }
        }
      }
    }
    return overlaps
  })
}
