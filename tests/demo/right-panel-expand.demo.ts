import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

/** The expand toggle in the Explorer pane's own header (beside "pop out"). */
const EXPAND_BTN = '#file-tree-host .pane-maximize-btn'

/**
 * Open the files pane if it is not already visible. A toggle click while open
 * would close it, so callers that share a session must stay idempotent.
 */
async function openRightPanel(): Promise<void> {
  const filesPane = $('#pane-files')
  if (await filesPane.isDisplayed()) return
  await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
  await filesPane.waitForDisplayed()
}

/**
 * Geometry plus what is actually painted over chat. The rects alone would pass
 * on a pane that is the right size but stacked underneath, so the probe also
 * hit-tests the middle of the chat column.
 */
async function probeLayout() {
  return browser.execute((expandSelector: string) => {
    const pane = document.getElementById('pane-files')
    const body = document.getElementById('body')
    const chat = document.getElementById('pane-chat')
    const btn = document.querySelector(expandSelector)
    if (!pane || !body || !chat || !btn) return null
    const paneRect = pane.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const chatRect = chat.getBoundingClientRect()
    const overChat = document.elementFromPoint(
      chatRect.left + chatRect.width / 2,
      chatRect.top + chatRect.height / 2,
    )
    return {
      maximized: body.classList.contains('is-right-panel-maximized'),
      paneWidth: paneRect.width,
      bodyWidth: bodyRect.width,
      // Distance from each body edge; all four collapse to 0 once expanded.
      insetGaps: [
        paneRect.left - bodyRect.left,
        bodyRect.right - paneRect.right,
        paneRect.top - bodyRect.top,
        bodyRect.bottom - paneRect.bottom,
      ],
      paneOverChat: pane.contains(overChat),
      chatOnTop: chat.contains(overChat),
      label: btn.getAttribute('aria-label'),
      pressed: btn.getAttribute('aria-pressed'),
    }
  }, EXPAND_BTN)
}

describe('right panel expanded over chat', () => {
  // One load for the whole file, like chat-layout-styling.demo.ts: remounting
  // per test on the same URL has stalled under CI load.
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=chat-layout-styling')
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })
    await openRightPanel()
  })

  it('gives the pane the whole body area and covers chat', async () => {
    await $(EXPAND_BTN).click()
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.getElementById('body')?.classList.contains('is-right-panel-maximized')),
        ),
      { timeoutMsg: 'right panel never took the expanded class' },
    )

    const layout = await probeLayout()
    expect(layout).not.toBeNull()
    if (!layout) throw new Error('missing right-panel layout probe')
    expect(layout.maximized).toBe(true)
    for (const gap of layout.insetGaps) expect(Math.abs(gap)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(layout.paneWidth - layout.bodyWidth)).toBeLessThanOrEqual(0.5)
    // Chat keeps its own geometry underneath — the pane is painted over it.
    expect(layout.paneOverChat).toBe(true)
    expect(layout.chatOnTop).toBe(false)
    // The way back sits where the way in was.
    expect(layout.label).toBe('Restore explorer')
    expect(layout.pressed).toBe('true')

    await saveAppScreenshot('right-panel-expanded.png')
  })

  it('restores the split view from the same control', async () => {
    await $(EXPAND_BTN).click()
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !document.getElementById('body')?.classList.contains('is-right-panel-maximized'),
        ),
      { timeoutMsg: 'right panel never left the expanded class' },
    )

    const layout = await probeLayout()
    expect(layout).not.toBeNull()
    if (!layout) throw new Error('missing right-panel layout probe')
    expect(layout.maximized).toBe(false)
    expect(layout.paneWidth).toBeLessThan(layout.bodyWidth)
    expect(layout.chatOnTop).toBe(true)
    expect(layout.label).toBe('Expand explorer over chat')
    expect(layout.pressed).toBe('false')
  })
})
