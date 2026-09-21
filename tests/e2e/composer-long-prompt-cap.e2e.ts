import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedComposerLongPromptFixture,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  waitForSettledLayout,
} from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'

/**
 * #2489: a long prompt used to either grow an internal scrollbar past the
 * fold or, at a short window, push the card's top edge (banners, the attach
 * button) above `.pane-chat`'s clipped top while the footer (Send,
 * model/branch pickers) stayed anchored to the bottom — so the two ends of
 * the same card were never both visible.
 *
 * Short enough that `.prompt-input`'s own `max-height: 40vh` — computed
 * against the *real*, unresized launch viewport, since this only resizes
 * `#app`'s inline style (see `prepareE2eScreenshot`) — does not shrink to
 * match. The fix's outer cap is a `%` of `.pane-chat`, which does track this
 * resize, so this height is exactly what distinguishes the two.
 */
const SHORT_VIEWPORT = { width: 900, height: 300 }

function longLines(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `Requirement line ${String(i + 1)} of a much longer prompt than the box.`,
  ).join('\n')
}

interface ComposerCapMetrics {
  error?: string
  appTop: number
  appBottom: number
  inputBarTop: number
  footerBottom: number
  branchTop: number
  branchBottom: number
  scrollbarWidth: string
  overflowY: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

async function readComposerCapMetrics(): Promise<ComposerCapMetrics> {
  return browser.execute((): ComposerCapMetrics => {
    const app = document.getElementById('app')
    const inputBar = document.getElementById('input-bar')
    const footer = document.querySelector('.input-footer')
    const branch = document.querySelector('.footer-branch-host')
    const prompt = document.querySelector('.prompt-input')
    if (!app || !inputBar || !footer || !branch || !(prompt instanceof HTMLElement)) {
      return {
        error: 'missing element',
        appTop: 0,
        appBottom: 0,
        inputBarTop: 0,
        footerBottom: 0,
        branchTop: 0,
        branchBottom: 0,
        scrollbarWidth: '',
        overflowY: '',
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
      }
    }
    const appRect = app.getBoundingClientRect()
    const barRect = inputBar.getBoundingClientRect()
    const footerRect = footer.getBoundingClientRect()
    const branchRect = branch.getBoundingClientRect()
    const style = getComputedStyle(prompt)
    return {
      appTop: appRect.top,
      appBottom: appRect.bottom,
      inputBarTop: barRect.top,
      footerBottom: footerRect.bottom,
      branchTop: branchRect.top,
      branchBottom: branchRect.bottom,
      scrollbarWidth: style.scrollbarWidth,
      overflowY: style.overflowY,
      scrollTop: prompt.scrollTop,
      scrollHeight: prompt.scrollHeight,
      clientHeight: prompt.clientHeight,
    }
  })
}

describe('composer long-prompt cap (#2489)', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const workspaceRoot = seedStableWorkspace()
    seedComposerLongPromptFixture(workspaceRoot, longLines(200))
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // Shrink *before* the draft hydrates (below), not after: the composer's
    // `value` setter scrolls to `scrollHeight` at the box's *current* height,
    // and a later resize can shrink `clientHeight` further without anything
    // re-clamping `scrollTop` — a real product gap (nothing here re-scrolls
    // on resize), but a different one from #2489, so the short window is set
    // up first to test that instead of tripping over it.
    await prepareE2eScreenshot(SHORT_VIEWPORT)
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const prompt = document.querySelector('.prompt-input')
          return prompt instanceof HTMLElement && prompt.scrollHeight > prompt.clientHeight + 20
        }),
      { timeout: 15_000, timeoutMsg: 'the 200-line draft never hydrated into the composer' },
    )
  })

  after(() => {
    resetUserData()
  })

  it('keeps the card top edge, footer and branch picker on screen for a restored long draft', async () => {
    // The 200-line `draftPrompt` lands via the real `syncComposerThread` path
    // (composer-editor.ts's `value` setter) once the store hydrates after
    // launch — the same path a genuinely long saved draft takes on reopening
    // a thread, and the one place the scroll-to-bottom JS in this PR runs.
    await waitForSettledLayout('#input-bar')

    const m = await readComposerCapMetrics()
    expect(m.error).toBeUndefined()

    // The card's top edge and its footer (Send, model/branch pickers) both
    // stay inside the window — neither end got pushed out by the draft.
    expect(m.inputBarTop).toBeGreaterThanOrEqual(m.appTop - 1)
    expect(m.footerBottom).toBeLessThanOrEqual(m.appBottom + 1)
    expect(m.branchTop).toBeGreaterThanOrEqual(m.appTop - 1)
    expect(m.branchBottom).toBeLessThanOrEqual(m.appBottom + 1)

    // The box is still scrollable (arrow keys / wheel reach earlier lines)
    // but draws no visible scrollbar chrome.
    expect(m.overflowY).toBe('auto')
    expect(m.scrollbarWidth).toBe('none')

    // The draft genuinely overflows the box (otherwise the assertions above
    // are vacuous)...
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight + 20)
    // ...and what's visible is the tail — scrolled to (or effectively at) the
    // bottom — rather than the top of a 200-line draft nobody asked to see
    // first.
    expect(m.scrollTop).toBeGreaterThanOrEqual(m.scrollHeight - m.clientHeight - 2)

    await browser
      .$('#input-bar')
      .saveScreenshot(join(E2E_SCREENSHOT_DIR, 'composer-long-prompt-cap-restored-draft.png'))
  })

  it('keeps the same guarantees typing a long prompt line by line', async () => {
    // Clear the restored draft, then type real keystrokes — WebdriverIO's
    // `addValue` drives Chromedriver's key-input pipeline, which Chromium
    // treats as trusted user input, unlike a scripted `execCommand` or the
    // composer's own `value` setter (covered by the previous test). One long
    // wrapped line rather than many `\n`-joined ones: Enter submits the
    // composer here (Shift+Enter is the newline), so literal newline
    // keystrokes would send the draft instead of growing it.
    await setComposerValue('')
    const words = Array.from({ length: 400 }, (_, i) => `word${String(i + 1)}`)
    await $('.prompt-input').addValue(words.join(' '))
    await waitForSettledLayout('#input-bar')

    const m = await readComposerCapMetrics()
    expect(m.error).toBeUndefined()
    expect(m.inputBarTop).toBeGreaterThanOrEqual(m.appTop - 1)
    expect(m.footerBottom).toBeLessThanOrEqual(m.appBottom + 1)
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight + 20)
    // Chromium's native "keep the caret in view" scroll is what should carry
    // this case — no JS in this PR runs on real typing. It lands the caret's
    // line just inside the fold rather than pixel-flush with the box's own
    // maximum scrollTop, so the tolerance is a line height, not a couple of
    // px like the exact `scrollTop = scrollHeight` assignment above.
    expect(m.scrollTop).toBeGreaterThanOrEqual(m.scrollHeight - m.clientHeight - 24)

    await browser
      .$('#input-bar')
      .saveScreenshot(join(E2E_SCREENSHOT_DIR, 'composer-long-prompt-cap-typed.png'))
  })
})
