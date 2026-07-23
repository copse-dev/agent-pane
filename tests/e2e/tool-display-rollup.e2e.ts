import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('tool call turn rollup', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedToolDisplayFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('collapses a mixed tool turn into one past-tense summary without boxed chrome', async () => {
    await $('.tool-card-rollup').waitForExist({ timeout: 30_000 })

    const rollup = await $('.tool-card-rollup')
    await expect(rollup).toBeDisplayed()
    await expect(rollup).not.toHaveAttribute('open')
    await expect(rollup.$('.tool-card-header .tool-name')).toHaveText('Used 3 tools · 1 failed')

    await saveAppScreenshot('tool-display-rollup-collapsed.png')

    await rollup.$('summary.tool-card-header').click()
    await expect(rollup).toHaveAttribute('open')
    await expect(rollup.$('.tool-card-group .tool-name')).toHaveText('Read files')
    await expect(rollup.$('.tool-card-group .tool-count')).toHaveText('×2')
    await expect(rollup.$('.tool-card[data-tool-id="tc-read-2"] .tool-name')).toHaveText(
      'Read file',
    )
    await expect(rollup.$('.tool-card[data-tool-id="tc-read-2"]')).toHaveAttribute(
      'data-status',
      'error',
    )

    await saveAppScreenshot('tool-display-rollup-expanded.png')
  })
})
