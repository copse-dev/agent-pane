import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedPrPanelChatFixture,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('PR panel gh unavailable (mock)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({
      COPSE_PANEL_MOCK_GH: '1',
      COPSE_PANEL_MOCK_GH_STATUS: 'unavailable',
    })
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

  it('shows chat-linked PRs with install guidance', async function () {
    this.timeout(60_000)
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Pull requests"]').click()
    await browser.pause(800)

    await (await $('.git-changes-section-title*=From chat')).waitForDisplayed({ timeout: 10_000 })

    const bannerText = await browser.execute(
      () => document.querySelector('.pr-empty-state')?.textContent?.trim() ?? '',
    )
    expect(bannerText.toLowerCase()).toMatch(/not installed|install github cli/)

    await saveElementScreenshot('#pane-files', 'pr-panel-gh-unavailable.png')
  })
})
