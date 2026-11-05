import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedBrowserToolsFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { frameInTranscript } from './helpers/sticky-prompt.ts'
import { waitForTranscriptScrollSettled } from './helpers/scroll-to-bottom.ts'

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

    const rollup = await $('.tool-card-rollup').getElement()
    await expect(rollup).toBeDisplayed()
    await expect(rollup.$('summary.tool-card-header .tool-name')).toHaveText('Used browser')
    await expect(rollup.$('summary.tool-card-header .tool-count')).toHaveText('×3')

    const screenshot = $(
      '[data-message-id="msg-assistant-browser"] > .tool-result-images .tool-result-preview-image',
    )
    await screenshot.waitForDisplayed({ timeout: 15_000 })
    await expect(screenshot).toHaveAttribute('alt', 'browser-tab-1.png')
    assert.match((await screenshot.getAttribute('src')) ?? '', /^data:image\/png;base64,/)

    // Two CI runs of one head captured this differently: wait for the
    // preview to decode and the transcript's scroll to settle first.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const image = document.querySelector<HTMLImageElement>(
            '[data-message-id="msg-assistant-browser"] > .tool-result-images .tool-result-preview-image',
          )
          return Boolean(image?.complete && image.naturalWidth > 0)
        }),
      { timeout: 15_000, timeoutMsg: 'expected the browser screenshot preview to decode' },
    )
    await waitForTranscriptScrollSettled()
    await saveAppScreenshot('browser-tools-collapsed.png')

    await rollup.$('summary.tool-card-header').click()
    await expect(rollup).toHaveAttribute('open')
    const group = await rollup.$('.tool-card-group').getElement()
    await expect(group.$('.tool-name')).toHaveText('Used browser')
    await expect(screenshot).toBeDisplayed()
    // Expanding the rollup grows the answer past the scrollport. Frame what
    // this capture shows, the opened rollup down to the screenshot beneath
    // it, instead of capturing wherever the scroll landed.
    const framed = await frameInTranscript([
      '[data-message-id="msg-assistant-browser"] .tool-card-rollup',
      '[data-message-id="msg-assistant-browser"] > .tool-result-images',
    ])
    assert.ok(framed.fits, JSON.stringify(framed))
    await saveAppScreenshot('browser-tools-expanded.png')

    await group.$(':scope > summary').click()
    await expect(group).toHaveAttribute('open')

    const screenshotTool = await group.$('[data-tool-id="tc-browser-screenshot"]').getElement()
    await expect(screenshotTool).toBeDisplayed()
    await screenshotTool.$(':scope > summary').click()
    await expect(screenshotTool).toHaveAttribute('open')

    const result = await screenshotTool.$('.tool-result').getElement()
    await expect(result).toHaveText(
      expect.stringContaining('Capture handle (thread-scoped and short-lived):'),
    )
    await expect(result).not.toHaveText(expect.stringContaining('/tmp/browser-screenshots'))
    await saveAppScreenshot('browser-tools-screenshot-handle.png')
  })
})
