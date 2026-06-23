import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedToolDisplayFixture } from './helpers/seed-config.ts'
import { itSkipInCi } from './helpers/ci-gate.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

type DividerProbe = {
  resizerId: string
  leftPaneId: string
  rightPaneId: string
}

const DIVIDER_PROBES: DividerProbe[] = [
  { resizerId: 'resizer-projects', leftPaneId: 'pane-projects', rightPaneId: 'pane-chat' },
  { resizerId: 'resizer-files', leftPaneId: 'pane-chat', rightPaneId: 'pane-files' },
  { resizerId: 'resizer-tree', leftPaneId: 'right-sidebar', rightPaneId: 'file-viewer' },
]

async function measureDivider(resizerId: string, leftPaneId: string, rightPaneId: string) {
  return browser.execute(
    (resizerSel, leftSel, rightSel) => {
      const resizer = document.getElementById(resizerSel)
      const leftPane = document.getElementById(leftSel)
      const rightPane = document.getElementById(rightSel)
      if (!resizer || !leftPane || !rightPane) return null

      const resizerRect = resizer.getBoundingClientRect()
      const leftRect = leftPane.getBoundingClientRect()
      const rightRect = rightPane.getBoundingClientRect()

      return {
        resizerWidth: resizerRect.width,
        leftGap: resizerRect.left - leftRect.right,
        rightGap: rightRect.left - resizerRect.right,
      }
    },
    resizerId,
    leftPaneId,
    rightPaneId,
  )
}

describe('chat layout styling', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedToolDisplayFixture(process.cwd())
    await browser.reloadSession()
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 15_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps pane dividers flush on both sides with no layout breaks', async () => {
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    await panelBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    for (const probe of DIVIDER_PROBES) {
      const metrics = await measureDivider(probe.resizerId, probe.leftPaneId, probe.rightPaneId)
      expect(metrics).not.toBeNull()
      expect(metrics!.resizerWidth).toBeLessThanOrEqual(1.5)
      expect(Math.abs(metrics!.leftGap)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(metrics!.rightGap)).toBeLessThanOrEqual(0.5)
    }

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'chat-layout-dividers-flush.png'))
  })

  it('renders a visible chat gradient through transparent conversation layers', async () => {
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
    expect(gradient!.backgroundImage).toContain('radial-gradient')
    expect(gradient!.backgroundImage).toContain('linear-gradient')
    expect(gradient!.scrollBackground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(gradient!.listBackground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(gradient!.gradientTop).not.toBe(gradient!.gradientBottom)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'chat-layout-three-pane.png'))

    const projectsResizer = await $('#resizer-projects')
    await projectsResizer.moveTo()
    await browser.pause(150)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'chat-layout-divider-hover.png'))
  })

  // A second mid-test reloadSession + empty-composer render reliably overruns
  // the mocha timeout on the constrained CI runner (even at 60s); skip in CI.
  itSkipInCi('shows the gradient in an empty composer-centered chat', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-chat-gradient-project')
    await browser.reloadSession()

    await $('.project-new-thread-btn').waitForClickable({ timeout: 15_000 })
    await $('.project-new-thread-btn').click()
    await $('.pane-chat.composer-centered').waitForExist({ timeout: 10_000 })

    const gradient = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      if (!pane) return null
      return getComputedStyle(pane).backgroundImage
    })
    expect(gradient).toContain('linear-gradient')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'chat-layout-gradient-empty.png'))
  })
})
