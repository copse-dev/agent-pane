import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('ChatGPT plan connection onboarding', () => {
  before(async () => {
    await browser.url('/?scenario=chatgpt-plan-settings')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  it('makes usage management the primary action when the plan allowance is reached', async () => {
    const action = $('.markdown-alert-caution a[href="https://chatgpt.com/settings/usage"]')
    await expect(action).toHaveText('Manage usage')
    await expect(action).toHaveStyle({ display: 'inline-flex' })
    await expect($('[aria-label="Manage ChatGPT usage"]')).toBeDisplayed()
    await saveAppScreenshot('chatgpt-plan-composer.png')
    await saveElementScreenshot('.message-body', 'chatgpt-plan-usage-limit.png')
  })

  it('shows the welcome once and refreshes through the public API boundary', async () => {
    await $('[aria-label="Settings"]').click()

    const welcome = $('#confirm-dialog')
    await expect(welcome).not.toBeDisplayed()
    const openAi = $('#settings-providers-host .provider-chip[data-provider="openai"]')
    await openAi.click()
    await expect(welcome).toBeDisplayed()
    await expect(welcome).toHaveText('You’re using your ChatGPT plan', { containing: true })
    await expect(welcome).toHaveText('available credits', { containing: true })
    await saveElementScreenshot('#confirm-dialog', 'chatgpt-plan-welcome.png')
    await $('.confirm-dialog-confirm').click()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.api.settings.get('chatGptPlanWelcomeSeen'))) === true,
      { timeout: 15_000 },
    )
    const section = $('[data-testid="chatgpt-plan-section"]')
    await expect(section).toHaveText('Using ChatGPT plan', { containing: true })
    await section.$('summary').click()
    await section.$('button=Refresh connection').click()
    await expect(section).toHaveText('Connection refreshed.', { containing: true })
    await expect(welcome).not.toBeDisplayed()
    await expect(section.$('button=Refresh connection')).toBeDisplayed()
    await saveElementScreenshot(
      '[data-testid="chatgpt-plan-section"]',
      'chatgpt-plan-account-options.png',
    )
    await $('#settings-dialog .settings-nav-btn[data-section="general"]').click()
    await $('[aria-label="Close settings"]').click()
    await $('[aria-label="Settings"]').click()
    await openAi.click()
    await expect(section).toHaveText('Using ChatGPT plan', { containing: true })
    await expect(welcome).not.toBeDisplayed()
  })
  it('hides plan usage management on other provider routes', async () => {
    await browser.url('/?scenario=footer-compact')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('[aria-label="Manage ChatGPT usage"]')).not.toBeDisplayed()
  })
})
