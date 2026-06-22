import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

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

  it('uses thin pane dividers and a subtle chat gradient', async () => {
    const projectsResizer = await $('#resizer-projects')
    await expect(projectsResizer).toBeDisplayed()

    const dividerWidth = await browser.execute(() => {
      const resizer = document.getElementById('resizer-projects')
      if (!resizer) return null
      return getComputedStyle(resizer, '::before').width
    })
    expect(dividerWidth).toBe('1px')

    const chatBackground = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      if (!pane) return null
      return getComputedStyle(pane).backgroundImage
    })
    expect(chatBackground).toContain('radial-gradient')
    expect(chatBackground).toContain('linear-gradient')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'chat-layout-three-pane.png'))

    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    await panelBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'chat-layout-with-files-pane.png'))

    await projectsResizer.moveTo()
    await browser.pause(150)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'chat-layout-divider-hover.png'))
  })
})
