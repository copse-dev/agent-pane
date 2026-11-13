import { browser, expect } from '@wdio/globals'

/** How far text must stay inside a captured frame's left and right edges. */
const FRAME_GUTTER_PX = 8

/**
 * Runs in the browser, so it keeps nothing at module scope. Lists what a
 * capture of `selector` would show cut off at, or jammed against, its side
 * edges: a page or subject that scrolls sideways, text clipped by an
 * `overflow` box on its way to the frame, and text closer than `gutter` to the
 * frame's left or right edge. `scrollWidth` alone cannot see text clipped by a
 * nested `overflow: hidden` box, so every visible text run is measured too.
 * Deliberate truncation (`text-overflow: ellipsis`), the contents of a box that
 * scrolls sideways and visually hidden labels do not count.
 */
function sidewaysFitProblems(selector: string, gutter: number): string[] {
  const subject = document.querySelector(selector)
  if (!(subject instanceof HTMLElement)) return [`${selector} is missing`]
  const problems: string[] = []
  const page = document.documentElement
  // clientWidth, not innerWidth: a classic scrollbar takes its width from the
  // viewport, and innerWidth would let content run underneath it.
  if (page.scrollWidth > page.clientWidth) {
    problems.push(
      `page scrolls sideways: ${String(page.scrollWidth)}px wide in ${String(page.clientWidth)}px`,
    )
  }
  if (subject.scrollWidth > subject.clientWidth) {
    problems.push(
      `${selector} scrolls sideways: ${String(subject.scrollWidth)}px wide in ${String(subject.clientWidth)}px`,
    )
  }
  const describe = (box: Element): string =>
    [
      box.tagName.toLowerCase(),
      box.id ? `#${box.id}` : '',
      ...[...box.classList].map((c) => `.${c}`),
    ]
      .filter(Boolean)
      .join('')
  const frame = subject.getBoundingClientRect()
  const walker = document.createTreeWalker(subject, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? ''
    const owner = node.parentElement
    if (!text || !owner?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      continue
    }
    const range = document.createRange()
    range.selectNodeContents(node)
    const run = range.getBoundingClientRect()
    if (run.width === 0) continue
    const label = text.length > 40 ? `${text.slice(0, 40)}…` : text
    let left = run.left
    let right = run.right
    let counts = true
    for (let box: Element | null = owner; box && box !== subject; box = box.parentElement) {
      const bounds = box.getBoundingClientRect()
      // A 1px box is a visually hidden label; nobody is meant to see its text.
      if (bounds.width <= 1 || bounds.height <= 1) {
        counts = false
        break
      }
      const style = getComputedStyle(box)
      if (style.overflowX === 'visible') continue
      const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll'
      if (scrolls && box.scrollWidth > box.clientWidth) {
        // A sideways scroller shows the rest of its text when scrolled.
        counts = false
        break
      }
      if (style.textOverflow === 'ellipsis') {
        left = Math.max(left, bounds.left)
        right = Math.min(right, bounds.right)
        continue
      }
      if (left < bounds.left - 0.5 || right > bounds.right + 0.5) {
        problems.push(`"${label}" is cut off by ${describe(box)}`)
        counts = false
        break
      }
    }
    if (!counts) continue
    const inset = Math.round(Math.min(left - frame.left, frame.right - right))
    if (inset < gutter) {
      problems.push(`"${label}" sits ${String(inset)}px from the edge of ${selector}`)
    }
  }
  return problems
}

/**
 * Fail a capture of `selector` that would land in a reference with content
 * running past, or touching, its left or right edge. Call it from the
 * capture's `beforeCapture`, so it measures the frame the helper is about to
 * save rather than the page before the helper framed it.
 */
export async function expectCaptureFitsWidth(selector: string): Promise<void> {
  const problems = await browser.execute(sidewaysFitProblems, selector, FRAME_GUTTER_PX)
  expect(problems).toEqual([])
}
