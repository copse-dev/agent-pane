import { join } from 'node:path'
import { browser } from '@wdio/globals'
import { recentreClippedCapture, restoreScrollAfterCapture } from './capture-framing.ts'

/** Fixed viewport for committed e2e reference screenshots (see tests/e2e/screenshots/). */
export const E2E_VIEWPORT = { width: 1280, height: 800 } as const

export const E2E_SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

/** Pin the app shell to a fixed size and settle layout before capturing. */
export async function prepareE2eScreenshot(
  size: { width: number; height: number } = E2E_VIEWPORT,
): Promise<void> {
  await browser.execute((viewport) => {
    const app = document.getElementById('app')
    if (!app) return
    const width = Math.min(viewport.width, window.innerWidth)
    const height = Math.min(viewport.height, window.innerHeight)
    app.style.width = `${width}px`
    app.style.height = `${height}px`
    app.style.overflow = 'hidden'
    app.style.boxSizing = 'border-box'
    window.dispatchEvent(new Event('resize'))
  }, size)
  await browser.pause(100)
}

/** Wider frame for three-pane reference shots (projects + chat + right panel). */
export const E2E_THREE_PANE_VIEWPORT = { width: 1600, height: 800 } as const

export async function prepareThreePaneScreenshot(): Promise<void> {
  await browser.execute((viewport) => {
    const app = document.getElementById('app')
    const body = document.getElementById('body')
    if (app) {
      app.style.width = `${viewport.width}px`
      app.style.height = `${viewport.height}px`
      app.style.overflow = 'hidden'
      app.style.boxSizing = 'border-box'
    }
    if (body) {
      body.style.setProperty('--projects-width', '260px')
      body.style.setProperty('--files-width', '480px')
      body.style.setProperty('--tree-width', '200px')
    }
    window.dispatchEvent(new Event('resize'))
  }, E2E_THREE_PANE_VIEWPORT)
  await browser.pause(150)
}

/** Capture the three-pane body with projects sidebar + chat + right panel visible. */
export async function saveThreePaneScreenshot(
  filename: string,
  options: { filesPaneWidth?: number } = {},
): Promise<void> {
  await prepareThreePaneScreenshot()
  if (options.filesPaneWidth !== undefined) {
    await browser.execute((width) => {
      document.getElementById('body')?.style.setProperty('--files-width', `${String(width)}px`)
      window.dispatchEvent(new Event('resize'))
    }, options.filesPaneWidth)
    await browser.pause(100)
  }
  const body = await browser.$('#body.three-pane')
  await body.waitForDisplayed({ timeout: 15_000 })
  await body.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/** Capture the app shell at the fixed viewport (excludes OS chrome). */
export async function saveAppScreenshot(
  filename: string,
  size: { width: number; height: number } = E2E_VIEWPORT,
): Promise<void> {
  await prepareE2eScreenshot(size)
  const app = await browser.$('#app')
  await app.waitForDisplayed({ timeout: 15_000 })
  await waitForSettledLayout('#app')
  await app.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/**
 * Maximize chat width and relax overflow clipping so message/table captures are
 * not truncated by the projects sidebar or pane overflow.
 */
export async function prepareChatMessageScreenshot(
  size: { width: number; height: number } = E2E_VIEWPORT,
): Promise<void> {
  await prepareE2eScreenshot(size)
  await browser.execute(() => {
    document.getElementById('pane-projects')?.setAttribute('hidden', '')
    document.getElementById('resizer-projects')?.setAttribute('hidden', '')
    document.getElementById('body')?.style.setProperty('--projects-width', '0px')
    const app = document.getElementById('app')
    if (app) app.style.overflow = 'visible'
    for (const sel of ['#body', '.pane-chat', '.conversation-scroll', '.messages-list']) {
      const el = document.querySelector(sel) as HTMLElement | null
      if (el) el.style.overflow = 'visible'
    }
    window.dispatchEvent(new Event('resize'))
  })
  await browser.pause(100)
}

/** Capture the app shell with projects hidden so chat/table shots are not clipped. */
export async function saveChatPaneScreenshot(filename: string): Promise<void> {
  await prepareChatMessageScreenshot()
  await browser.execute(() => {
    document.querySelector('.message-text table')?.scrollIntoView({ block: 'start' })
  })
  await browser.pause(100)
  const app = await browser.$('#app')
  await app.waitForDisplayed({ timeout: 15_000 })
  await app.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/** Capture a message sub-tree once {@link prepareChatMessageScreenshot} has run. */
export async function savePreparedElementScreenshot(
  selector: string,
  filename: string,
): Promise<void> {
  await prepareChatMessageScreenshot()
  await browser.execute((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'start', inline: 'nearest' })
  }, selector)
  await browser.pause(100)
  const el = await browser.$(selector)
  await el.waitForDisplayed({ timeout: 15_000 })
  await el.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/**
 * Wait until every `<img>` inside `selector` has finished decoding.
 *
 * A pane can be "displayed" well before it is *settled*. Material file icons
 * mount as `<img decoding="async">` once their row exists, so a capture taken as
 * soon as the list appears catches rows whose icons have not painted. That is a
 * distinct stage from the list itself appearing, so waiting on the list element
 * alone is not enough.
 *
 * This is not hypothetical: `theme-boot-popout-light.png` accumulated three
 * different committed baselines across three unrelated PRs — a blank pane, rows
 * without icons, and rows with icons — because the capture landed on whichever
 * stage the popout had reached. The ping-pong guard from #609 does not catch it,
 * since each render is a state that was never committed before and so reads as
 * "clearly different" every time.
 *
 * Pass `minImages` whenever the settled pane is known to contain icons. The
 * explorer's `.file-tree` is appended empty and filled asynchronously, so a host
 * still showing a blank list contains no `<img>` — and a wait over zero images
 * succeeds immediately, capturing exactly the blank frame it was meant to avoid.
 */
export async function waitForImagesSettled(
  selector: string,
  options: { minImages?: number; timeout?: number } = {},
): Promise<void> {
  const { minImages = 0, timeout = 15_000 } = options
  await browser.waitUntil(
    () =>
      browser.execute(
        (sel: string, min: number) => {
          const host = document.querySelector(sel)
          if (!host) return false
          const images = Array.from(host.querySelectorAll('img'))
          // An empty host has no <img> at all, so `every` would report settled
          // while the list is still blank. Callers that know the settled pane
          // must contain icons pass `minImages` to close that hole.
          if (images.length < min) return false
          return images.every((img) => img.complete && img.naturalWidth > 0)
        },
        selector,
        minImages,
      ),
    {
      timeout,
      timeoutMsg:
        minImages > 0
          ? `${selector} did not settle with at least ${String(minImages)} loaded image(s)`
          : `images inside ${selector} did not finish loading`,
    },
  )
}

/**
 * Wait until nothing under `selector` is still moving: every scroll offset in
 * the subtree and the element's own box must read the same across consecutive
 * animation frames. Smooth scrolling is the usual offender — a spec that does
 * `scrollIntoView({ behavior: 'smooth' })` (or clicks something that does) and
 * then waits for `scrollTop > 0` captures whatever frame the animation had
 * reached, which is a different frame on every runner. That is exactly how
 * `settings-styling-nav-subheadings.png` and `settings-usage-plan-worth-it-inference.png`
 * came back a few dozen pixels apart with no UI change behind them.
 *
 * Bounded: after `timeout` the capture proceeds anyway, so a genuinely animated
 * surface (a spinner) cannot hang a spec — it just does not get the guarantee.
 */
export async function waitForSettledLayout(
  target: string | WebdriverIO.Element,
  options: { timeout?: number; stableFrames?: number } = {},
): Promise<void> {
  const { timeout = 3_000, stableFrames = 3 } = options
  const deadline = Date.now() + timeout
  let previous: string | null = null
  let stable = 0
  while (Date.now() < deadline) {
    // A WDIO element crosses into the page as the DOM node itself; a selector
    // is looked up there. Specs hand `saveElementScreenshot` either.
    const snapshot = await browser.execute((subject: string | Element) => {
      const host = typeof subject === 'string' ? document.querySelector(subject) : subject
      if (!host) return null
      const rect = host.getBoundingClientRect()
      const parts = [rect.top, rect.left, rect.width, rect.height]
      const nodes = [host, ...host.querySelectorAll('*')]
      for (const node of nodes) {
        // Only scrollports carry a meaningful offset; skipping the rest keeps
        // the walk cheap on a large settings form.
        if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) {
          parts.push(node.scrollTop, node.scrollLeft)
        }
      }
      return parts.join(',')
    }, target)
    if (snapshot !== null && snapshot === previous) {
      stable += 1
      if (stable >= stableFrames) return
    } else {
      stable = 0
    }
    previous = snapshot
    // Two frames at 60Hz, so a smooth scroll still in flight reads differently.
    await browser.pause(34)
  }
}

/**
 * Capture a single element after pinning the viewport (footer, input bar, etc.).
 *
 * The pin happens *after* the caller has scrolled its subject into view, and it
 * shrinks the shell — so on a tall-windowed runner the subject can end up
 * outside the pinned box and the capture comes back truncated, with the
 * settings action bar over whatever is left. Re-centre in that case only; see
 * {@link recentreClippedCapture} for the measurements and for why an element
 * already inside the shell is deliberately left exactly where the spec put it.
 */
export async function saveElementScreenshot(selector: string, filename: string): Promise<void> {
  await prepareE2eScreenshot()
  const el = await browser.$(selector)
  await el.waitForDisplayed({ timeout: 15_000 })
  const saved = await browser.execute(recentreClippedCapture, el, '#app')
  if (saved) {
    // Let the scroll settle before capturing, as the prepare step does.
    await browser.pause(100)
  }
  await waitForSettledLayout(el)
  await el.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
  // Hand the page back exactly as the caller left it — the scroll was for the
  // capture, and specs keep interacting with the page afterwards.
  if (saved) await browser.execute(restoreScrollAfterCapture, el, saved)
}

/**
 * Replace text that only the wall clock can produce with a fixed stand-in for
 * the duration of a capture, and put it back afterwards.
 *
 * This is the last resort, not the first: the rule (docs/testing-strategy.md,
 * "Deterministic screenshots") is to seed timestamps and ids through fixtures
 * or an e2e env override so the product renders the same thing every run. Use
 * this only for a value no fixture can reach — the trigger time of an
 * automation run the real scheduler just fired, for instance — and keep the
 * DOM assertion that proves the real text was there. Everything else in the
 * frame is still the product's own rendering.
 *
 * Only text nodes are rewritten, only where `pattern` matches, so layout and
 * markup are untouched. The pin is re-applied whenever the page mutates under
 * `selector` until it is restored: the projects pane rebuilds its rows on
 * every store change, and a rebuild between the pin and the capture would
 * otherwise bring the live text straight back. Returns a restore function;
 * call it once the capture is saved so the spec keeps interacting with the
 * real page.
 */
export async function pinTextForCapture(
  selector: string,
  pattern: RegExp,
  replacement: string,
): Promise<() => Promise<void>> {
  const count = await browser.execute(
    (sel: string, source: string, flags: string, next: string) => {
      type Pin = { observer: MutationObserver; pinned: Map<Text, string> }
      const win = window as unknown as { __copsePinnedText?: Pin }
      const re = new RegExp(source, flags)
      const pinned = new Map<Text, string>()
      const apply = (): number => {
        const host = document.querySelector(sel)
        if (!host) return 0
        let applied = 0
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node as Text
          const replaced = text.data.replace(re, next)
          // Already pinned (or nothing to pin): leave it, or the observer
          // would chase its own writes.
          if (replaced === text.data) continue
          if (!pinned.has(text)) pinned.set(text, text.data)
          text.data = replaced
          applied += 1
        }
        return applied
      }
      const first = apply()
      const observer = new MutationObserver(() => {
        observer.disconnect()
        apply()
        observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      win.__copsePinnedText?.observer.disconnect()
      win.__copsePinnedText = { observer, pinned }
      return first
    },
    selector,
    pattern.source,
    pattern.flags,
    replacement,
  )
  if (count === 0) {
    throw new Error(
      `pinTextForCapture: nothing under ${selector} matched ${String(pattern)} — the value it exists to hide is not there, so the capture would not be pinning anything`,
    )
  }
  return async () => {
    await browser.execute(() => {
      type Pin = { observer: MutationObserver; pinned: Map<Text, string> }
      const win = window as unknown as { __copsePinnedText?: Pin }
      const pin = win.__copsePinnedText
      if (!pin) return
      pin.observer.disconnect()
      // A node the page has since replaced already shows the live text.
      for (const [node, text] of pin.pinned) if (node.isConnected) node.data = text
      delete win.__copsePinnedText
    })
  }
}
