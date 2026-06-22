import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedPortraitRightPanelFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function simulateViewport(width: number, height: number): Promise<void> {
  await browser.execute(
    (nextWidth, nextHeight) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: nextWidth })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: nextHeight })
      window.dispatchEvent(new Event('resize'))
    },
    width,
    height,
  )
}

async function openExplorerInPortraitWindow(autoPortraitRightPanel: boolean): Promise<void> {
  resetUserData()
  seedPortraitRightPanelFixture(process.cwd(), autoPortraitRightPanel)
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await simulateViewport(640, 1000)
  await $('[aria-label="Toggle right panel"]').click()
  await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
}

describe('portrait right panel layout', () => {
  before(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('moves the right panel below projects and chat on tall portrait windows', async () => {
    await openExplorerInPortraitWindow(true)

    await browser.waitUntil(
      async () =>
        (await (await $('#body')).getAttribute('class'))?.includes('is-right-panel-horizontal'),
      { timeout: 5_000, timeoutMsg: 'expected portrait right panel layout class' },
    )

    const layout = await browser.execute(() => {
      const chat = document.getElementById('pane-chat')!.getBoundingClientRect()
      const projects = document.getElementById('pane-projects')!.getBoundingClientRect()
      const files = document.getElementById('pane-files')!.getBoundingClientRect()
      const input = document.getElementById('input-bar')!.getBoundingClientRect()
      return {
        projectsTop: projects.top,
        chatTop: chat.top,
        filesTop: files.top,
        chatBottom: chat.bottom,
        inputBottom: input.bottom,
      }
    })

    expect(Math.abs(layout.projectsTop - layout.chatTop)).toBeLessThan(2)
    expect(layout.filesTop).toBeGreaterThan(layout.chatBottom)
    expect(Math.abs(layout.inputBottom - layout.chatBottom)).toBeLessThan(2)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'portrait-right-panel-auto.png'))
  })

  it('keeps the side panel layout when portrait auto-layout is disabled', async () => {
    await openExplorerInPortraitWindow(false)

    await expect($('#body')).not.toHaveElementClass('is-right-panel-horizontal')

    const layout = await browser.execute(() => {
      const chat = document.getElementById('pane-chat')!.getBoundingClientRect()
      const files = document.getElementById('pane-files')!.getBoundingClientRect()
      return {
        chatTop: chat.top,
        filesTop: files.top,
        filesLeft: files.left,
        chatRight: chat.right,
      }
    })

    expect(Math.abs(layout.filesTop - layout.chatTop)).toBeLessThan(2)
    expect(layout.filesLeft).toBeGreaterThan(layout.chatRight)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'portrait-right-panel-disabled.png'))
  })
})
