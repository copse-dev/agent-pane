import { $, browser, expect } from '@wdio/globals'

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
    const settled = await browser.execute((offset: number) => {
      window.scrollTo(0, offset)
      return Math.round(window.scrollY)
    }, READING_OFFSET)
    expect(settled).toBe(READING_OFFSET)

    // Record every scroll of the *embedding page* from here on. The demo's own
    // scrolling happens inside the iframe and never reaches this listener.
    await browser.execute(() => {
      window.addEventListener(
        'scroll',
        () => {
          const seen = (window as unknown as { __pageJumps?: number[] }).__pageJumps ?? []
          seen.push(Math.round(window.scrollY))
          ;(window as unknown as { __pageJumps?: number[] }).__pageJumps = seen
        },
        { passive: true },
      )
    })

    // The walkthrough types, replays a turn, then opens and expands the preview.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const frame = document.getElementById('hero-demo-frame') as HTMLIFrameElement | null
          return frame?.contentDocument?.documentElement.dataset['demoExpandedPane'] === 'browser'
        }),
      { timeout: 150_000, timeoutMsg: 'expected the hero run to finish and expand the preview' },
    )

    // The transcript settles a beat after expansion — that is when the old
    // `scrollIntoView` used to yank the page.
    await browser.pause(4_000)

    const jumps = await browser.execute(
      () => (window as unknown as { __pageJumps?: number[] }).__pageJumps ?? [],
    )
    expect(jumps).toEqual([])
    expect(await browser.execute(() => Math.round(window.scrollY))).toBe(READING_OFFSET)
  })
})
