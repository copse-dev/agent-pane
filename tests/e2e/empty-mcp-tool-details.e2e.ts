import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyMcpToolFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('empty MCP tool details', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyMcpToolFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('reveals a clear empty state inside an expanded rollup entry', async () => {
    const rollup = $('.tool-card-rollup')
    await rollup.waitForExist({ timeout: 30_000 })
    await expect(rollup.$$('.tool-result-empty')).toBeElementsArrayOfSize(0)

    await rollup.$('summary.tool-card-header').click()
    const card = $('[data-tool-id="tc-empty-mcp-ping"]')
    await card.waitForDisplayed({ timeout: 5_000 })
    await card.$('summary.tool-card-header').click()

    await expect(card).toHaveAttribute('open')
    await expect(card.$$('.tool-args')).toBeElementsArrayOfSize(0)
    await expect(card.$$('.tool-result-empty')).toBeElementsArrayOfSize(1)
    await expect(card.$('.tool-result-empty')).toHaveText('No tool details were provided.')

    await saveElementScreenshot('.tool-card-rollup', 'empty-mcp-tool-details.png')
  })
})
