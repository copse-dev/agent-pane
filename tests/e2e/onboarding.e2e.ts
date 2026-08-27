import { $, browser, expect } from '@wdio/globals'
import { readSeededSettings, resetUserData, seedOnboardingFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

// First-run with nothing detected: the automatic scan only checks local model
// servers and agents, so shell keys cannot make this host-dependent. A developer
// machine with a live local server lands in checklist mode instead; the spec
// detects that and skips. The scan-import spec covers both the explicit
// environment-key choice and checklist path with deterministic detections.
describe('onboarding: nothing detected → providers fallback', () => {
  before(async () => {
    // This spec exercises the explicitly enabled compatibility fallback on
    // keyring-less Linux CI. The default-off behavior has its own focused spec.
    writeE2eEnv({ COPSE_ALLOW_PLAINTEXT_SECRETS: '1' })
    seedOnboardingFixture()
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_ALLOW_PLAINTEXT_SECRETS: undefined })
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
      // A real local server on this machine put onboarding in checklist mode.
      this.skip()
      return
    }

    const chips = overlay.$('#onboarding-fallback-panel .provider-chips')
    await chips.waitForDisplayed({ timeout: 15_000 })
    await saveAppScreenshot('onboarding-fallback-providers.png')

    // Enter an Anthropic key by hand — the same form Settings → General shows.
    await overlay.$('.provider-chip[data-provider="anthropic"]').click()
    const keyInput = overlay.$('#onboarding-fallback-panel input[type="password"]')
    await keyInput.waitForDisplayed({ timeout: 15_000 })
    await keyInput.setValue('sk-ant-e2e-onboarding-fallback-0001')

    await overlay.$('#onboarding-finish').click()
    // On runners without an OS keyring (Linux docker), saving the key raises the
    // plaintext-consent confirm dialog and finish waits on it. Approve it —
    // which also makes the on-disk key assertion below hold on every platform.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const confirm = document.querySelector<HTMLDialogElement>('#confirm-dialog')
          if (confirm?.open) {
            confirm.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')?.click()
          }
          return document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open === false
        }),
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
