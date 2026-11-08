import { $, browser, expect } from '@wdio/globals'
import { observePageScrollAfterSetup } from './helpers/page-scroll-observer.ts'

/**
 * The hero embeds the demo in a same-origin iframe, where two ordinary things
 * reach past the frame and scroll copse.dev itself: `scrollIntoView` walks
 * every scrollable ancestor, and focusing any control focuses the frame, which
 * Chromium then brings into view. Both fire while a run finishes — it opens the
 * Browser pane (address-bar focus) and settles the transcript. A reader partway
 * down the page must stay exactly where they are through all of it, so assert
 * on the page's own scroll events rather than on either mechanism.
 */
describe('marketing hero demo', () => {
  it('never scrolls the marketing page when the run finishes', async function () {
    this.timeout(180_000)
    await browser.setWindowSize(1280, 800)
    await browser.url('/marketing/index.html')
    await $('.hero-demo-frame').waitForExist()

    // The hero only loads the demo above the mobile breakpoint.
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.getElementById('hero-demo-frame')?.hasAttribute('src') === true,
        ),
      { timeout: 20_000, timeoutMsg: 'expected the hero to load the demo iframe' },
    )

    const READING_OFFSET = 1800
    // Consume the deliberate setup scroll before observing the embedding page.
    // A synchronous scrollY read alone can leave its event queued for the observer.
    const settled = await browser.execute(observePageScrollAfterSetup, READING_OFFSET)
    expect(settled).toBe(READING_OFFSET)

    // The walkthrough types, replays a turn, then opens and expands the preview.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const frame = document.getElementById('hero-demo-frame')
          if (!(frame instanceof HTMLIFrameElement)) throw new Error('Missing hero demo iframe')
          return frame.contentDocument?.documentElement.dataset['demoExpandedPane'] === 'browser'
        }),
      { timeout: 150_000, timeoutMsg: 'expected the hero run to finish and expand the preview' },
    )

    // The transcript settles a beat after expansion — that is when the old
    // `scrollIntoView` used to yank the page.
    await browser.pause(4_000)

    const jumps = await browser.execute(() => window.__pageJumps ?? [])
    expect(jumps).toEqual([])
    expect(await browser.execute(() => Math.round(window.scrollY))).toBe(READING_OFFSET)

    // Positive control after the run assertion: the same observer must detect
    // real movement away and back, including a later event at the setup offset.
    for (const offset of [READING_OFFSET + 80, READING_OFFSET]) {
      const count = await browser.execute(() => window.__pageJumps?.length ?? 0)
      await browser.execute((next: number) => {
        window.scrollTo(0, next)
      }, offset)
      await browser.waitUntil(
        () =>
          browser.execute(
            (previous: number) => (window.__pageJumps?.length ?? 0) > previous,
            count,
          ),
        { timeout: 5_000, timeoutMsg: `expected the control scroll event at ${String(offset)}` },
      )
    }
    expect(await browser.execute(() => window.__pageJumps)).toEqual([
      READING_OFFSET + 80,
      READING_OFFSET,
    ])
  })
})
