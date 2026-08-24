import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readSeededSettings, resetUserData, seedOnboardingFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'

// First-run with nothing detected: CI blanks every provider env var
// (wdio.conf.ts beforeSession) and runs no local model servers, so the scan
// finds nothing usable and onboarding swaps in the providers fallback panel.
// A developer machine with keys in ~/.zshrc or a live local server lands in
// checklist mode instead — the spec detects that and skips (the scan-import
// spec covers the checklist path deterministically by injecting detections).
describe('onboarding: nothing detected → providers fallback', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    seedOnboardingFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('offers the settings providers panel and finishes with a manually-entered key', async function () {
    this.timeout(120_000)
    const overlay = await $('#onboarding-dialog')
    await overlay.waitForDisplayed({ timeout: 30_000 })
    await expect(overlay.$('h2')).toHaveText('Welcome to Copse')

    // The overlay is a native modal <dialog>, not a hidden-toggled div.
    expect(
      await browser.execute(
        () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open,
      ),
    ).toBe(true)

    // Wait for the auto-scan to settle into one of its two modes.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const fallback = document.querySelector<HTMLElement>('#onboarding-fallback-panel')
          const results = document.querySelector('.onboarding-scan-results')
          return fallback?.hidden === false || (results?.childElementCount ?? 0) > 0
        }),
      { timeout: 30_000, timeoutMsg: 'onboarding scan never settled' },
    )

    const fallbackShown = await browser.execute(
      () => document.querySelector<HTMLElement>('#onboarding-fallback-panel')?.hidden === false,
    )
    if (!fallbackShown) {
      // Real keys/servers on this machine put onboarding in checklist mode; the
      // fallback path is CI-deterministic only.
      this.skip()
      return
    }

    const chips = overlay.$('#onboarding-fallback-panel .provider-chips')
    await chips.waitForDisplayed({ timeout: 15_000 })
    await prepareE2eScreenshot()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'onboarding-fallback-providers.png'))

    // Enter an Anthropic key by hand — the same form Settings → General shows.
    await overlay.$('.provider-chip[data-provider="anthropic"]').click()
    const keyInput = overlay.$('#onboarding-fallback-panel input[type="password"]')
    await keyInput.waitForDisplayed({ timeout: 15_000 })
    await keyInput.setValue('sk-ant-e2e-onboarding-fallback-0001')

    await overlay.$('#onboarding-finish').click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open === false,
        ),
      { timeout: 30_000, timeoutMsg: 'onboarding did not close after finish' },
    )

    const settings = readSeededSettings()
    expect(settings['onboardingCompleted']).toBe(true)
    expect(settings['model']).toBe('auto:balanced')
    expect(settings['localDefaultModel']).toBe('auto:best-local')
    // With no local server, local-model background work stays off.
    expect(settings['localSubagentsEnabled']).toBe(false)
    const apiKeys = settings['apiKey'] as Record<string, unknown> | undefined
    const anthropicKey = apiKeys?.['anthropic'] ?? settings['apiKey.anthropic']
    expect(anthropicKey).toBeDefined()
  })
})
