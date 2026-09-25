import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('Git attribution setting', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-git-attribution-setting')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('starts enabled and saves an explicit opt-out', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="agent"]').click()

    const section = $('[data-testid="git-attribution-settings"]')
    const toggle = section.$('input[name="gitAttributionEnabled"]')
    await expect(section).toBeDisplayed()
    await expect(toggle).toBeSelected()
    expect(await section.getText()).toContain('Credit Copse on commits and pull requests')
    await saveElementScreenshot(
      '[data-testid="git-attribution-settings"]',
      'git-attribution-on.png',
    )

    await toggle.click()
    await $('#settings-dialog button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="agent"]').click()
    await expect(toggle).not.toBeSelected()
    await expect(section).toBeDisplayed()
    await saveElementScreenshot(
      '[data-testid="git-attribution-settings"]',
      'git-attribution-off.png',
    )
  })
})
