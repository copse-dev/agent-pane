import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('tool call display', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedToolDisplayFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows human-readable names and grouped tool cards', async () => {
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 15_000 })

    const groupCard = await $('.tool-card-group')
    await expect(groupCard).toBeDisplayed()
    await expect(groupCard).not.toHaveAttribute('open')
    await expect(groupCard.$('.tool-name')).toHaveText('Reading files')
    await expect(groupCard.$('.tool-count')).toHaveText('×2')

    const failedCard = await $('.tool-card[data-tool-id="tc-read-2"]')
    await expect(failedCard).toBeDisplayed()
    await expect(failedCard.$('.tool-name')).toHaveText('Read file')
    await expect(failedCard).toHaveAttribute('data-status', 'error')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'tool-display-collapsed.png'))

    await groupCard.$('summary.tool-card-header').click()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'tool-display-group-expanded.png'))
  })
})
