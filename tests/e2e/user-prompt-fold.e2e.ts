import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedUserPromptFoldFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('user prompt mid-fold accordion', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedUserPromptFoldFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-user-fold"] .msg-user-fold-toggle').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('collapses prompts over 10 lines and expands on toggle', async () => {
    const bubble = await $('[data-message-id="msg-user-fold"]')
    const toggle = await bubble.$('.msg-user-fold-toggle')
    const fold = await bubble.$('.message-text.msg-user-fold')

    await expect(fold).toHaveElementClass('msg-user-fold')
    await expect(fold).not.toHaveElementClass('is-expanded')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(bubble.$('.msg-user-fold-label')).toHaveText(/lines hidden/)
    await expect(bubble.$('.msg-user-fold-head')).toHaveText(/Session notes/)
    await expect(bubble.$('.msg-user-fold-tail')).toHaveText(/What I saw/)
    await expect(bubble.$('.msg-user-fold-middle')).not.toBeDisplayed()

    await saveElementScreenshot(
      '[data-message-id="msg-user-fold"]',
      'user-prompt-fold-collapsed.png',
    )
    await saveAppScreenshot('user-prompt-fold-collapsed-app.png')

    await toggle.click()
    await expect(fold).toHaveElementClass('is-expanded')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(bubble.$('.msg-user-fold-label')).toHaveText('collapse')
    await expect(bubble.$('.msg-user-fold-middle')).toBeDisplayed()
    await expect(bubble.$('.msg-user-fold-middle')).toHaveText(/Environment note/)

    await saveElementScreenshot(
      '[data-message-id="msg-user-fold"]',
      'user-prompt-fold-expanded.png',
    )
    await saveAppScreenshot('user-prompt-fold-expanded-app.png')
  })
})
