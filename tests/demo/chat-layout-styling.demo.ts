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

async function openRightPanel(): Promise<void> {
  await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
  await $('#pane-files').waitForDisplayed()
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
  beforeEach(async () => {
    await browser.url('/?scenario=chat-layout-styling')
    await $('.messages-list .msg-assistant').waitForExist()
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
    const gradient = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      const scroll = document.querySelector('.conversation-scroll')
      const list = document.querySelector('.messages-list')
      if (!pane || !scroll || !list) return null
      const paneStyle = getComputedStyle(pane)
      const rootStyle = getComputedStyle(document.documentElement)
      return {
        backgroundImage: paneStyle.backgroundImage,
        scrollBackground: getComputedStyle(scroll).backgroundColor,
        listBackground: getComputedStyle(list).backgroundColor,
        gradientTop: rootStyle.getPropertyValue('--chat-gradient-top').trim(),
        gradientBottom: rootStyle.getPropertyValue('--chat-gradient-bottom').trim(),
      }
    })

    expect(gradient).not.toBeNull()
    if (!gradient) throw new Error('Missing chat gradient elements')
    expect(gradient.backgroundImage).toContain('radial-gradient')
    expect(gradient.backgroundImage).toContain('linear-gradient')
    expect(gradient.scrollBackground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(gradient.listBackground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(gradient.gradientTop).not.toBe(gradient.gradientBottom)

    await saveAppScreenshot('chat-layout-three-pane.png')
    await $('#resizer-projects').moveTo()
    await saveAppScreenshot('chat-layout-divider-hover.png')
  })

  it('shows the gradient in an empty composer-centered chat', async () => {
    await $('.project-new-thread-btn').click()
    await $('.pane-chat.composer-centered').waitForExist()
    const gradient = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      return pane ? getComputedStyle(pane).backgroundImage : ''
    })
    expect(gradient).toContain('linear-gradient')
    await saveAppScreenshot('chat-layout-gradient-empty.png')
  })
})
