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
 * Geometry plus what is actually painted where. Rects alone would pass on a pane
 * that is the right size but stacked underneath, so the probe also hit-tests the
 * middle of the chat column and of the projects rail.
 */
async function probeLayout() {
  return browser.execute((expandSelector: string) => {
    const pane = document.getElementById('pane-files')
    const body = document.getElementById('body')
    const chat = document.getElementById('pane-chat')
    const projects = document.getElementById('pane-projects')
    const btn = document.querySelector(expandSelector)
    if (!pane || !body || !chat || !projects || !btn) return null
    const paneRect = pane.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const chatRect = chat.getBoundingClientRect()
    const projectsRect = projects.getBoundingClientRect()
    const at = (rect: DOMRect): Element | null =>
      document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const overChat = at(chatRect)
    const overProjects = at(projectsRect)
    return {
      maximized: body.classList.contains('is-right-panel-maximized'),
      paneWidth: paneRect.width,
      bodyWidth: bodyRect.width,
      projectsWidth: projectsRect.width,
      // Trailing edges run flush to the window; the leading edge stops at chat.
      trailingGaps: [
        bodyRect.right - paneRect.right,
        paneRect.top - bodyRect.top,
        bodyRect.bottom - paneRect.bottom,
      ],
      // Negative = the pane starts left of chat, i.e. it is eating the rail.
      paneToChatLeft: paneRect.left - chatRect.left,
      paneOverChat: pane.contains(overChat),
      chatOnTop: chat.contains(overChat),
      projectsOnTop: projects.contains(overProjects),
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

  it('takes the chat column and leaves the thread list in place', async () => {
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
    for (const gap of layout.trailingGaps) expect(Math.abs(gap)).toBeLessThanOrEqual(0.5)
    // Starts exactly where chat starts: all of chat, none of the projects rail.
    expect(Math.abs(layout.paneToChatLeft)).toBeLessThanOrEqual(1)
    expect(layout.paneWidth).toBeGreaterThan(layout.bodyWidth - layout.projectsWidth - 2)
    // Chat keeps its own geometry underneath — the pane is painted over it.
    expect(layout.paneOverChat).toBe(true)
    expect(layout.chatOnTop).toBe(false)
    // Threads stay visible and clickable beside the expanded pane.
    expect(layout.projectsOnTop).toBe(true)
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
    expect(layout.projectsOnTop).toBe(true)
    expect(layout.label).toBe('Expand explorer over chat')
    expect(layout.pressed).toBe('false')
  })
})
