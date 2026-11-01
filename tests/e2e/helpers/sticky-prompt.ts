import { browser } from '@wdio/globals'

export interface StickyPromptCollisions {
  /** False when the latest prompt is in normal flow (narrow panes). */
  sticky: boolean
  /** Visible transcript text lines the pinned prompt covers, even in part. */
  collisions: { text: string; top: number; bottom: number }[]
  /** Geometry for a readable failure: viewport-relative pixels. */
  geometry: {
    listTop: number
    listBottom: number
    promptBottom: number
    scrollTop: number
    maxScrollTop: number
    band: string
  } | null
}

/**
 * Transcript text that the pinned (sticky) latest human prompt covers. Only
 * line boxes inside the transcript's scrollport count, so text scrolled out of
 * view is not a collision; text tucked partly or wholly under the pinned
 * prompt is. Content scrolling behind a sticky header is normal, so pass
 * `scope` (a selector, and which match) to check only the rows a capture is
 * about, such as the answer it frames.
 */
export async function stickyPromptCollisions(scope?: {
  selector: string
  nth?: number
}): Promise<StickyPromptCollisions> {
  return browser.execute((only) => {
    const list = document.querySelector<HTMLElement>('.messages-list')
    if (!list) throw new Error('messages-list not found')
    const prompts = list.querySelectorAll<HTMLElement>(
      ':scope > .msg-user:not(.msg-machine-origin):not(.msg-hook-origin)',
    )
    const prompt = prompts[prompts.length - 1]
    if (!prompt || getComputedStyle(prompt).position !== 'sticky') {
      return { sticky: false, collisions: [], geometry: null }
    }
    const port = list.getBoundingClientRect()
    const band = prompt.getBoundingClientRect()
    const collisions: { text: string; top: number; bottom: number }[] = []
    const scoped = only ? document.querySelectorAll(only.selector)[only.nth ?? 0] : null
    if (only && !scoped) throw new Error(`${only.selector} [${String(only.nth ?? 0)}] not found`)
    const rows = scoped ? [scoped] : Array.from(list.children)
    for (const row of rows) {
      if (row === prompt || !(row instanceof HTMLElement)) continue
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        if (text.trim() === '') continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const line of range.getClientRects()) {
          if (line.width < 0.5 || line.height < 0.5) continue
          const top = Math.max(line.top, port.top, band.top)
          const bottom = Math.min(line.bottom, port.bottom, band.bottom)
          const left = Math.max(line.left, port.left, band.left)
          const right = Math.min(line.right, port.right, band.right)
          if (bottom - top > 0.5 && right - left > 0.5) {
            collisions.push({
              text: text.trim().slice(0, 80),
              top: line.top - port.top,
              bottom: line.bottom - port.top,
            })
          }
        }
      }
    }
    return {
      sticky: true,
      collisions,
      geometry: {
        listTop: port.top,
        listBottom: port.bottom,
        promptBottom: band.bottom - port.top,
        scrollTop: list.scrollTop,
        maxScrollTop: list.scrollHeight - list.clientHeight,
        band: list.style.getPropertyValue('--sticky-prompt-band'),
      },
    }
  }, scope)
}

export interface TranscriptFrame {
  /** True when the whole span shows below the pinned prompt and above the list's bottom. */
  fits: boolean
  top: number
  bottom: number
  clearance: number
  viewport: number
}

/**
 * Scroll the transcript so the span from the first selector's top to the last
 * selector's bottom shows in full, clear of the stuck latest prompt (the band
 * conversation.ts publishes as --sticky-prompt-band), and report whether it
 * fits. A span already in view is left where it is; one clipped below moves
 * up just enough, and one under the pinned band moves down, so its top wins
 * when it cannot fit. `nth` picks the nth match of every selector.
 */
export async function frameInTranscript(
  selectors: readonly string[],
  nth = 0,
): Promise<TranscriptFrame> {
  return browser.execute(
    async (targets, index) => {
      const list = document.querySelector<HTMLElement>('.messages-list')
      if (!list) throw new Error('messages-list not found')
      const find = (target: string): HTMLElement => {
        const element = document.querySelectorAll<HTMLElement>(target)[index]
        if (!element) throw new Error(`${target} [${String(index)}] not found`)
        return element
      }
      const rects = targets.map((target) => find(target).getBoundingClientRect())
      const clearance = Number.parseFloat(list.style.getPropertyValue('--sticky-prompt-band')) || 0
      const span = (): { top: number; bottom: number } => {
        const port = list.getBoundingClientRect()
        const current = targets.map((target) => find(target).getBoundingClientRect())
        return {
          top: Math.min(...current.map((rect) => rect.top)) - port.top,
          bottom: Math.max(...current.map((rect) => rect.bottom)) - port.top,
        }
      }
      if (rects.length === 0) throw new Error('frameInTranscript needs a selector')
      const before = span()
      const viewport = list.clientHeight
      if (before.bottom > viewport) list.scrollTop += before.bottom - viewport
      const moved = span()
      if (moved.top < clearance) list.scrollTop -= clearance - moved.top
      list.dispatchEvent(new Event('scroll'))
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve()
          })
        })
      })
      const after = span()
      return {
        fits: after.top >= clearance - 1 && after.bottom <= viewport + 1,
        top: after.top,
        bottom: after.bottom,
        clearance,
        viewport,
      }
    },
    selectors,
    nth,
  )
}
