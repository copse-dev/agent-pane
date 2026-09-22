import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedBrowserToolsFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('browser tool display', () => {
  before(async () => {
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

    await saveAppScreenshot('browser-tools-collapsed.png')

    await rollup.$('summary.tool-card-header').click()
    await expect(rollup).toHaveAttribute('open')
    const group = await rollup.$('.tool-card-group')
    await expect(group.$('.tool-name')).toHaveText('Used browser')
    await saveAppScreenshot('browser-tools-expanded.png')

    await group.$(':scope > summary').click()
    await expect(group).toHaveAttribute('open')

    const screenshot = await group.$('[data-tool-id="tc-browser-screenshot"]')
    await expect(screenshot).toBeDisplayed()
    await screenshot.$(':scope > summary').click()
    await expect(screenshot).toHaveAttribute('open')

    const result = await screenshot.$('.tool-result')
    await expect(result).toHaveText(
      expect.stringContaining('Capture handle (thread-scoped and short-lived):'),
    )
    await expect(result).not.toHaveText(expect.stringContaining('/tmp/browser-screenshots'))
    await saveAppScreenshot('browser-tools-screenshot-handle.png')
  })
})
