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
    const pane = await $('#pane-files').getElement()
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()

    await (await $('.git-changes-section-title*=Related PRs')).waitForDisplayed({ timeout: 10_000 })
    // Missing gh is a terminal state, not an in-flight CI lookup. Capture
    // only once the chat-linked row reports that same settled result.
    await expect($('.pr-list-row[data-pr-section="linked"] .pr-list-checks-label')).toHaveText(
      'CI unavailable',
    )

    const bannerText = await browser.execute(
      () => document.querySelector('.pr-empty-state')?.textContent.trim() ?? '',
    )
    expect(bannerText.toLowerCase()).toMatch(/not installed|install github cli/)
    // Listing a chat-linked PR must not leave the viewer on its cold-start
    // "Loading pull requests…" spinner: gh has answered, and it is missing.
    const viewerEmpty = await $('#pr-viewer-host .panel-empty').getElement()
    await expect(viewerEmpty).toHaveText('GitHub CLI is not available')
    await expect($('#pr-viewer-host .panel-empty .ui-inline-status')).not.toBeExisting()

    await saveElementScreenshot('#pane-files', 'pr-panel-gh-unavailable.png')
  })
})
