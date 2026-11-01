import { browser } from '@wdio/globals'

/** Consecutive identical reads that count as settled (each `SETTLE_POLL_MS` apart). */
const SETTLED_READS = 3
const SETTLE_POLL_MS = 50

/** The conversation navigation controls docked between transcript and composer. */
export const NAVIGATION_CONTROLS = ['.conversation-first-prompt', '.scroll-to-bottom'] as const

/**
 * Wait until the transcript's scroll position and size, and both navigation
 * controls, stop changing, with Back to latest shown or hidden as
 * `returnVisible` says. Replaces a fixed pause before a capture: the scroll
 * handler, the stream follow glide and late layout (fonts, disclosures) all
 * land on their own schedule, and a pause that is long enough on one host is
 * short on another.
 */
export async function waitForTranscriptScrollSettled(returnVisible: boolean): Promise<void> {
  let previous = ''
  let stableReads = 0
  await browser.waitUntil(
    async () => {
      const state = await browser.execute((selectors) => {
        const list = document.querySelector('.messages-list')
        if (!(list instanceof HTMLElement)) return null
        const controls = selectors.map((selector) => {
          const control = document.querySelector(selector)
          if (!(control instanceof HTMLElement)) return null
          const rect = control.getBoundingClientRect()
          return {
            visible: !control.hidden && rect.width > 0,
            signature: [control.hidden, rect.x, rect.y, rect.width, rect.height].join(','),
          }
        })
        const back = controls[1]
        if (!back) return null
        return {
          visible: back.visible,
          signature: [
            list.scrollTop,
            list.scrollHeight,
            list.clientHeight,
            ...controls.map((control) => control?.signature ?? 'missing'),
          ].join(';'),
        }
      }, NAVIGATION_CONTROLS)
      if (!state || state.visible !== returnVisible) {
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
      timeoutMsg: `expected the transcript scroll to settle with Back to latest ${
        returnVisible ? 'shown' : 'hidden'
      }`,
    },
  )
}

export interface TextOverlap {
  control: string
  text: string
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Rendered text that a visible navigation control covers: transcript rows,
 * the TODO panel and its counter, notices above the transcript and the queued
 * panel. Each text node's line boxes are clipped to the scrollport that shows
 * them, so text scrolled out of view does not count. A hidden control covers
 * nothing.
 */
export async function navigationTextOverlaps(
  selectors: readonly string[] = NAVIGATION_CONTROLS,
): Promise<TextOverlap[]> {
  return browser.execute((controlSelectors) => {
    const overlaps: {
      control: string
      text: string
      rect: { x: number; y: number; width: number; height: number }
    }[] = []
    const ports = Array.from(
      document.querySelectorAll<HTMLElement>('.conversation-scroll, .conversation-queued'),
    ).filter((port) => !port.hidden)
    for (const selector of controlSelectors) {
      const control = document.querySelector(selector)
      if (!(control instanceof HTMLElement) || control.hidden) continue
      const box = control.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      for (const port of ports) {
        const walker = document.createTreeWalker(port, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? ''
          if (text.trim() === '') continue
          // Clip to the nearest scroller: the transcript list, else the area.
          const scroller = node.parentElement?.closest('.messages-list') ?? port
          const view = scroller.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const line of range.getClientRects()) {
            const top = Math.max(line.top, view.top, box.top)
            const bottom = Math.min(line.bottom, view.bottom, box.bottom)
            const left = Math.max(line.left, view.left, box.left)
            const right = Math.min(line.right, view.right, box.right)
            if (bottom - top > 0.5 && right - left > 0.5) {
              overlaps.push({
                control: selector,
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
    }
    return overlaps
  }, selectors)
}
