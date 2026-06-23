import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedPrPanelChatFixture,
} from './helpers/seed-config.ts'
import { saveThreePaneScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('PR panel', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedPrPanelChatFixture(process.cwd())
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  async function openRightPanel(): Promise<void> {
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      const panelBtn = await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]')
      await panelBtn.click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
  }

  it('shows linked PRs and opens GitHub links in the PR panel', async function () {
    this.timeout(90_000)

    await openRightPanel()
    const prTab = await $('[aria-label="Pull requests"]')
    await prTab.waitForDisplayed({ timeout: 10_000 })
    await prTab.click()
    await browser.pause(400)

    const fromChat = await $('.git-changes-section-title*=From chat')
    await fromChat.waitForDisplayed({ timeout: 15_000 })
    await expect(fromChat).toHaveText(expect.stringMatching(/from chat/i))
    await saveThreePaneScreenshot('pr-panel-linked-list.png')

    const message = await $('[data-message-id="msg-assistant-pr-link"] .message-text')
    await message.waitForDisplayed({ timeout: 10_000 })
    const link = await message.$('a')
    await link.waitForDisplayed({ timeout: 5_000 })
    await link.click()

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const tab = document.querySelector('[aria-label="Pull requests"].is-active')
          const host = document.getElementById('pr-viewer-host')
          return tab != null && host != null && !host.hidden
        }),
      { timeout: 15_000, timeoutMsg: 'expected PR panel to open from chat link' },
    )

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const meta = document.querySelector('.pr-viewer-meta')
          return meta != null && meta.textContent != null && meta.textContent.trim().length > 0
        }),
      { timeout: 30_000, timeoutMsg: 'expected PR viewer metadata to render' },
    )

    await saveThreePaneScreenshot('pr-panel-viewer.png')
  })
})
