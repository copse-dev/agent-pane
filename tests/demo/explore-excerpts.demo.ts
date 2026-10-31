import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// #1433 Fix 0: an explore result carries harness-copied verbatim excerpts after
// the subagent's summary. The card must show the summary once, in the
// timeline, and render the excerpts below it as code.
describe('browser-hosted explore excerpts', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=explore-excerpts')
    await $('.tool-card-subagent').waitForExist()
  })

  it('shows the summary once and the verbatim excerpt as a code block', async () => {
    const card = await $('.tool-card-subagent').getElement()
    await card.$('summary.tool-card-header').click()
    const result = await card.$('.subagent-parent-result')
    await expect(result).toBeDisplayed()
    await expect(result).toHaveText(expect.stringContaining('Verbatim excerpts'))
    await expect(result.$('pre code')).toHaveText(
      expect.stringContaining("if (event.key === 'Enter') {"),
    )
    const cardText = await card.getText()
    const summary = 'wireToolbar submits the URL on Enter in browser-pane.ts.'
    assert.equal(cardText.split(summary).length - 1, 1, 'the summary renders exactly once')
    await saveAppScreenshot('explore-excerpts-expanded.png')
  })
})
