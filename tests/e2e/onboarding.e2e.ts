import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedOnboardingFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('onboarding panel', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    seedOnboardingFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('captures each onboarding step', async () => {
    const overlay = await $('#onboarding-dialog')
    await overlay.waitForDisplayed({ timeout: 30_000 })

    await expect(overlay.$('h2')).toHaveText('Welcome to Copse')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'onboarding-step-intro.png'))

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('#onboarding-next')?.click()
    })
    await expect(overlay.$('[data-step="cloud"].active')).toBeDisplayed()
    await expect(overlay.$('.onboarding-panel[data-step="cloud"].active legend')).toHaveText(
      'Cloud API keys (optional)',
    )
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'onboarding-step-cloud-keys.png'))

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('#onboarding-next')?.click()
    })
    await expect(overlay.$('[data-step="local"].active')).toBeDisplayed()
    await expect(
      overlay.$('.onboarding-panel[data-step="local"].active .setup-install-guide h4'),
    ).toHaveText('Don’t have LM Studio yet?')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'onboarding-step-local-models.png'))

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('#onboarding-next')?.click()
    })
    await expect(overlay.$('[data-step="routing"].active')).toBeDisplayed()
    await expect(overlay.$('.onboarding-panel[data-step="routing"].active')).toBeDisplayed()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'onboarding-step-routing.png'))
  })
})
