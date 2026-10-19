import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'

/**
 * Visual proof for the default-off plaintext secret policy. The e2e shell
 * injects unavailable storage at the native keyring and Electron safeStorage
 * boundaries so the state is independent of the runner host.
 */
describe('settings plaintext secret storage', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({
      COPSE_ALLOW_PLAINTEXT_SECRETS: undefined,
      COPSE_E2E_SECRET_STORAGE: 'unavailable',
    })
    resetUserData()
    // A key saved earlier, before secure storage went away, gives the list a
    // key row whose Options take a replacement key on dialog Save.
    seedOpenRouterFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({
      COPSE_ALLOW_PLAINTEXT_SECRETS: undefined,
      COPSE_E2E_SECRET_STORAGE: undefined,
    })
    resetUserData()
  })

  it('keeps Settings open and explains the environment opt-in', async function () {
    if (process.platform !== 'linux') {
      this.skip()
    }

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()

    const row = dialog.$('[data-testid="models-agents-list"] [data-row="key:openrouter"]')
    await row.waitForExist({ timeout: 15_000 })
    await row.$('button=Options').click()

    const form = row.$('.provider-form')
    const keyInput = form.$('input[type="password"]')
    await keyInput.waitForDisplayed({ timeout: 10_000 })
    const key = 'sk-or-v1-e2e-plaintext-policy'
    const staged = await browser.execute((value) => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-row="key:openrouter"] .provider-form input[type="password"]',
      )
      if (!input) return null
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    }, key)
    assert.equal(staged, key, 'expected the provider key to be staged and marked dirty')
    // This spec covers save policy, not sticky-footer pointer geometry. Submit
    // the real Settings form so a scrolled provider action cannot intercept the
    // WebDriver click while still exercising the production submit handler.
    const submitted = await browser.execute(() => {
      const settings = document.querySelector<HTMLFormElement>('#settings-dialog form')
      if (!settings) return false
      settings.requestSubmit()
      return true
    })
    assert.equal(submitted, true, 'expected the Settings form')

    const status = form.$('[data-provider-key-status="openrouter"]')
    await browser.waitUntil(
      async () => /COPSE_ALLOW_PLAINTEXT_SECRETS=1/.test(await status.getText()),
      { timeout: 10_000, timeoutMsg: 'plaintext-disabled guidance never appeared' },
    )

    await expect(dialog).toBeDisplayed()
    assert.match(await status.getText(), /secure storage is unavailable/i)
    assert.match(await status.getText(), /plaintext secret storage is disabled/i)
    // Lowercase after the colon, and the environment variable renders as code.
    assert.match(await status.getText(), /^Not saved: secure storage is unavailable/)
    await expect(status.$('code')).toHaveText('COPSE_ALLOW_PLAINTEXT_SECRETS=1')
    assert.equal(
      await browser.execute(
        () => document.querySelector<HTMLDialogElement>('#confirm-dialog')?.open ?? false,
      ),
      false,
      'the per-save plaintext consent prompt must not appear while the env gate is off',
    )

    const keyFieldSelector = '.provider-field-group:has([data-provider-key-status="openrouter"])'
    await browser.execute((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: 'center', inline: 'nearest' })
    }, keyFieldSelector)
    await saveElementScreenshot(keyFieldSelector, 'settings-plaintext-storage-disabled.png')
  })
})
