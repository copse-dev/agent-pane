import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedAdvisorDenialFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('advisor denial tool card', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAdvisorDenialFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the denial as readable paragraphs while keeping the call arguments separate', async () => {
    const card = await $('[data-tool-id="tc-advisor-denial"]')
    await card.waitForExist({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-status', 'error')
    await expect(card).toHaveAttribute('open')
    const result = card.$('.tool-result-error-message')
    await expect(result.$$('p')).toBeElementsArrayOfSize(5)
    await expect(result.$('p:first-child')).toHaveText(
      'This action was rejected due to unacceptable risk.',
    )
    const visibleText = await result.getText()
    expect(visibleText).toContain('full transcript and verified repository state')
    expect(visibleText).not.toContain('"result"')
    expect(visibleText).not.toContain('\\n')
    await expect(card.$('.tool-args summary')).toHaveText('Arguments')
    await card.scrollIntoView()
    await saveElementScreenshot('[data-tool-id="tc-advisor-denial"]', 'advisor-denial-readable.png')
  })
})
