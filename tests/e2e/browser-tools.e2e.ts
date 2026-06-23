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

  it('groups browser tool calls under a Browser card', async () => {
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })

    const groupCard = await $('.tool-card-group')
    await expect(groupCard).toBeDisplayed()
    await expect(groupCard.$('.tool-name')).toHaveText('Browser')
    await expect(groupCard.$('.tool-count')).toHaveText('×3')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-tools-collapsed.png'))

    await groupCard.$('summary.tool-card-header').click()
    await expect(groupCard).toHaveAttribute('open')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-tools-expanded.png'))
  })
})
