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

/**
 * Visual eval for spinning a local thread off the PR viewer ("New thread"):
 * shared-checkout preference + composer draft seeded with the PR markdown link.
 */
describe('PR panel new thread (mock gh)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
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

  async function openPrTab(): Promise<void> {
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()
    await browser.pause(800)
  }

  it('spins off a shared-checkout thread with the PR in the composer', async function () {
    this.timeout(120_000)

    await openPrTab()
    await browser.waitUntil(
      async () => {
        const el = await $('.pr-viewer-title')
        return (await el.isDisplayed()) && (await el.getText()).includes('Add GitHub PR panel tab')
      },
      { timeout: 15_000, timeoutMsg: 'expected auto-selected mock PR viewer' },
    )

    const newThreadBtn = await $('.pr-new-thread-btn')
    await newThreadBtn.waitForDisplayed({ timeout: 10_000 })
    await expect(newThreadBtn).toHaveText('New thread')
    await saveElementScreenshot('#pane-files', 'pr-panel-new-thread-action.png')

    await newThreadBtn.click()

    // `.prompt-input` is contenteditable — assert via text, not input value.
    await expect(await $('.prompt-input')).toHaveText(
      expect.stringMatching(/#42.*copse-dev\/copse-panel\/pull\/42/s),
      { wait: 10_000 },
    )
    await expect(await $('.footer-checkout-btn')).toHaveText('Shared checkout')
    await expect(await $('.chat-row.selected .chat-title')).toHaveText(
      expect.stringMatching(/^PR #42:/),
    )

    await saveElementScreenshot('#app', 'pr-panel-new-thread-composer.png')
  })
})
