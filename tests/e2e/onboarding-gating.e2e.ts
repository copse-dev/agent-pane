import { $, browser, expect } from '@wdio/globals'
import { readSeededSettings, resetUserData, seedOnboardingFixture } from './helpers/seed-config.ts'

// When onboarding shows and — just as important — when it never shows again.
// Dismissing in any form marks it complete, and a completed profile boots
// straight to the app.
describe('onboarding gating', () => {
  before(async () => {
    seedOnboardingFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows on a fresh profile', async () => {
    const overlay = await $('#onboarding-dialog')
    await overlay.waitForDisplayed({ timeout: 30_000 })
    expect(
      await browser.execute(
        () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open,
      ),
    ).toBe(true)
  })

  it('skip completes onboarding and leaves the welcome screen fully usable', async function () {
    this.timeout(60_000)
    await $('#onboarding-skip').click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open === false,
        ),
      { timeout: 15_000, timeoutMsg: 'skip did not close onboarding' },
    )
    await browser.waitUntil(async () => readSeededSettings()['onboardingCompleted'] === true, {
      timeout: 15_000,
      timeoutMsg: 'skip did not persist onboardingCompleted',
    })
    // Dismissal writes nothing beyond the flag — no imports, no model defaults.
    expect(readSeededSettings()['model']).toBeUndefined()
    expect(readSeededSettings()['envKeyAutoDetectEnabled']).toBeUndefined()

    // The welcome screen underneath must be interactive — the New Project flow
    // is the first thing a fresh user does after dismissing setup (issue #1914's
    // regression surface).
    const newProjectBtn = await $('.welcome-new-btn')
    await newProjectBtn.waitForClickable({ timeout: 15_000 })
    await newProjectBtn.click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector<HTMLDialogElement>('#new-project-dialog')?.open === true,
        ),
      { timeout: 15_000, timeoutMsg: 'New Project dialog did not open after skipping onboarding' },
    )
    await browser.keys('Escape')
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector<HTMLDialogElement>('#new-project-dialog')?.open === false,
        ),
      { timeout: 10_000, timeoutMsg: 'New Project dialog did not close' },
    )
  })

  it('never shows again on a completed profile', async function () {
    this.timeout(90_000)
    // Same profile, fresh app process — the completed flag written by skip gates it.
    await browser.reloadSession()
    await $('.welcome-new-btn').waitForDisplayed({ timeout: 30_000 })
    expect(
      await browser.execute(
        () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open ?? false,
      ),
    ).toBe(false)
  })
})
