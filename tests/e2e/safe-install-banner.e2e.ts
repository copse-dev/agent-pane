import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedSafeInstallBannerFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('safe-install banner', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedSafeInstallBannerFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('echoes the original command instead of the sfw wrapper', async () => {
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 15_000 })

    const oldCard = await $('.tool-card[data-tool-id="tc-install-old"]')
    const newCard = await $('.tool-card[data-tool-id="tc-install-new"]')
    await expect(oldCard).toBeDisplayed()
    await expect(newCard).toBeDisplayed()

    await oldCard.$('summary.tool-card-header').click()
    await newCard.$('summary.tool-card-header').click()

    const oldResult = await oldCard.$('.tool-result').getText()
    const newResult = await newCard.$('.tool-result').getText()

    // The new banner shows the original command and never the sfw shell wrapper.
    expect(newResult).toContain('$ npm install')
    expect(newResult).not.toContain('sfw /bin/sh -c')
    expect(newResult).not.toContain('npm_config_ignore_scripts')
    // The old banner (kept for the before/after screenshot) leaks the wrapper.
    expect(oldResult).toContain('sfw /bin/sh -c')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'safe-install-banner-before-after.png'))
  })
})
