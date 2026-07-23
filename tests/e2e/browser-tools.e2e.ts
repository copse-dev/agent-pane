import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedBrowserToolsFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('browser tool display', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedBrowserToolsFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('rolls browser tool calls into one Used browser summary', async () => {
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })

    const rollup = await $('.tool-card-rollup')
    await expect(rollup).toBeDisplayed()
    await expect(rollup.$('summary.tool-card-header .tool-name')).toHaveText('Used browser')
    await expect(rollup.$('summary.tool-card-header .tool-count')).toHaveText('×3')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-tools-collapsed.png'))

    await rollup.$('summary.tool-card-header').click()
    await expect(rollup).toHaveAttribute('open')
    await expect(rollup.$('.tool-card-group .tool-name')).toHaveText('Used browser')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-tools-expanded.png'))
  })
})
