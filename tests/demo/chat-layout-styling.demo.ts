import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

interface DividerProbe {
  resizerId: string
  leftPaneId: string
  rightPaneId: string
}

const DIVIDER_PROBES: DividerProbe[] = [
  { resizerId: 'resizer-projects', leftPaneId: 'pane-projects', rightPaneId: 'pane-chat' },
  { resizerId: 'resizer-files', leftPaneId: 'pane-chat', rightPaneId: 'pane-files' },
  { resizerId: 'resizer-tree', leftPaneId: 'right-sidebar', rightPaneId: 'file-viewer' },
]

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

async function measureDivider(probe: DividerProbe) {
  return browser.execute(({ resizerId, leftPaneId, rightPaneId }) => {
    const resizer = document.getElementById(resizerId)
    const leftPane = document.getElementById(leftPaneId)
    const rightPane = document.getElementById(rightPaneId)
    if (!resizer || !leftPane || !rightPane) return null
    const resizerRect = resizer.getBoundingClientRect()
    const leftRect = leftPane.getBoundingClientRect()
    const rightRect = rightPane.getBoundingClientRect()
    return {
      resizerWidth: resizerRect.width,
      leftGap: resizerRect.left - leftRect.right,
      rightGap: rightRect.left - resizerRect.right,
    }
  }, probe)
}

describe('browser-hosted chat layout styling', () => {
  // One load for the whole file. Remounting via beforeEach on the same URL
  // hung under CI load (4 parallel Chromes + concurrent check) and blew the
  // 30s mocha budget on tip 3f7a2961 — see develop run 30310911148.
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=chat-layout-styling')
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })
  })

  it('keeps pane dividers flush on both sides with no layout breaks', async () => {
    await openRightPanel()
    for (const probe of DIVIDER_PROBES) {
      const metrics = await measureDivider(probe)
      expect(metrics).not.toBeNull()
      if (!metrics) throw new Error(`Missing divider ${probe.resizerId}`)
      expect(metrics.resizerWidth).toBeLessThanOrEqual(1.5)
      expect(Math.abs(metrics.leftGap)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(metrics.rightGap)).toBeLessThanOrEqual(0.5)
    }
    await saveAppScreenshot('chat-layout-dividers-flush.png')
  })

  it('renders a visible chat gradient through transparent conversation layers', async () => {
    await openRightPanel()
    const appearance = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      const scroll = document.querySelector('.conversation-scroll')
      const list = document.querySelector('.messages-list')
      const titlebar = document.getElementById('titlebar')
      if (!pane || !scroll || !list || !titlebar) return null
      const paneStyle = getComputedStyle(pane)
      const rootStyle = getComputedStyle(document.documentElement)
      const trafficLights = getComputedStyle(titlebar, '::before')
      return {
        backgroundImage: paneStyle.backgroundImage,
        scrollBackground: getComputedStyle(scroll).backgroundColor,
        listBackground: getComputedStyle(list).backgroundColor,
        gradientTop: rootStyle.getPropertyValue('--chat-gradient-top').trim(),
        gradientBottom: rootStyle.getPropertyValue('--chat-gradient-bottom').trim(),
        trafficLights: {
          content: trafficLights.content,
          width: trafficLights.width,
          height: trafficLights.height,
          background: trafficLights.backgroundColor,
          shadows: trafficLights.boxShadow,
        },
      }
    })

    expect(appearance).not.toBeNull()
    if (!appearance) throw new Error('Missing chat appearance elements')
    expect(appearance.backgroundImage).toContain('radial-gradient')
    expect(appearance.backgroundImage).toContain('linear-gradient')
    expect(appearance.scrollBackground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(appearance.listBackground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(appearance.gradientTop).not.toBe(appearance.gradientBottom)
    expect(appearance.trafficLights.content).not.toBe('none')
    expect(appearance.trafficLights.width).toBe('12px')
    expect(appearance.trafficLights.height).toBe('12px')
    expect(appearance.trafficLights.background).toBe('rgb(255, 95, 87)')
    expect(appearance.trafficLights.shadows).toContain('rgb(254, 188, 46)')
    expect(appearance.trafficLights.shadows).toContain('rgb(40, 200, 64)')

    await saveAppScreenshot('chat-layout-three-pane.png')
    await $('#resizer-projects').moveTo()
    await saveAppScreenshot('chat-layout-divider-hover.png')
  })

  it('shows the gradient in an empty Activity-home chat', async () => {
    await $('.project-new-thread-btn').click()
    await $('.pane-chat.is-activity-home').waitForExist()
    const gradient = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      return pane ? getComputedStyle(pane).backgroundImage : ''
    })
    expect(gradient).toContain('linear-gradient')
    await saveAppScreenshot('chat-layout-gradient-empty.png')
  })

  it('docks the composer with its own single border under the Activity home', async () => {
    // Prior test already opened a blank thread; ensure we stay on that surface
    // without a full remount (another navigation was the flake surface).
    if (!(await $('.pane-chat.is-activity-home').isExisting())) {
      await $('.project-new-thread-btn').click()
      await $('.pane-chat.is-activity-home').waitForExist()
    }
    const layout = await browser.execute(() => {
      const home = document.getElementById('activity-home')
      const body = home?.querySelector('.activity-panel-body')
      const input = document.getElementById('input-bar')
      if (!home || !body || !input) return null
      const style = getComputedStyle(input)
      return {
        borderTop: style.borderTopWidth,
        bodyBottom: body.getBoundingClientRect().bottom,
        inputTop: input.getBoundingClientRect().top,
      }
    })
    expect(layout).not.toBeNull()
    if (!layout) throw new Error('Missing Activity home or #input-bar')
    expect(layout.borderTop).toBe('1px')
    expect(layout.bodyBottom).toBeLessThanOrEqual(layout.inputTop + 1)
    await saveAppScreenshot('chat-layout-activity-home.png')
  })
})
