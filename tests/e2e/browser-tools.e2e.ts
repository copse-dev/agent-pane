import assert from 'node:assert/strict'
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

  it('renders a screenshot outside the collapsed browser-tool rollup', async () => {
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })

    const rollup = await $('.tool-card-rollup')
    await expect(rollup).toBeDisplayed()
    await expect(rollup.$('summary.tool-card-header .tool-name')).toHaveText('Used browser')
    await expect(rollup).toHaveAttribute('data-tool-count', '3')

    const screenshot = $(
      '[data-message-id="msg-assistant-browser"] > .tool-result-images .tool-result-preview-image',
    )
    await screenshot.waitForDisplayed({ timeout: 15_000 })
    await expect(screenshot).toHaveAttribute('alt', 'browser-tab-1.png')
    assert.match(await screenshot.getAttribute('src'), /^data:image\/png;base64,/)

    await saveAppScreenshot('browser-tools-collapsed.png')

    await rollup.$('summary.tool-card-header').click()
    await expect(rollup).toHaveAttribute('open')
    await expect(rollup.$$('.tool-rollup-body > .tool-card')).toBeElementsArrayOfSize(3)
    await expect(screenshot).toBeDisplayed()
    await saveAppScreenshot('browser-tools-expanded.png')

    const screenshotTool = await rollup.$('[data-tool-id="tc-browser-screenshot"]')
    await expect(screenshotTool).toBeDisplayed()
    await screenshotTool.$(':scope > summary').click()
    await expect(screenshotTool).toHaveAttribute('open')

    const result = await screenshotTool.$('.tool-result')
    await expect(result).toHaveText(
      expect.stringContaining('Capture handle (thread-scoped and short-lived):'),
    )
    await expect(result).not.toHaveText(expect.stringContaining('/tmp/browser-screenshots'))
    await saveAppScreenshot('browser-tools-screenshot-handle.png')
  })
})
