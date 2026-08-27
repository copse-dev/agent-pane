import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

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
    seedEmptyProject(process.cwd(), 'e2e-plaintext-storage-disabled')
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
      return
    }

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()

    const selected = await browser.execute(() => {
      const chip = [...document.querySelectorAll<HTMLButtonElement>('.provider-chip')].find(
        // OpenAI also owns the Codex device agent. On a fresh Linux runner,
        // selecting it can legitimately open the ACP adapter-install approval
        // over Settings; OpenRouter exercises the same key policy without that
        // unrelated setup flow.
        (candidate) => candidate.textContent?.trim() === 'OpenRouter',
      )
      chip?.click()
      return Boolean(chip)
    })
    assert.equal(selected, true, 'expected an OpenRouter provider chip')

    const form = dialog.$('.provider-form')
    const keyInput = form.$('input[type="password"]')
    await keyInput.waitForDisplayed({ timeout: 10_000 })
    const key = 'sk-or-v1-e2e-plaintext-policy'
    const staged = await browser.execute((value) => {
      const selectedProvider = document.querySelector<HTMLButtonElement>('.provider-chip.active')
      const input = document.querySelector<HTMLInputElement>(
        '#settings-providers-host .provider-form input[type="password"]',
      )
      if (selectedProvider?.dataset.provider !== 'openrouter' || !input) return null
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
    assert.equal(
      await browser.execute(
        () => document.querySelector<HTMLDialogElement>('#confirm-dialog')?.open ?? false,
      ),
      false,
      'the per-save plaintext consent prompt must not appear while the env gate is off',
    )

    const keyFieldSelector =
      '.provider-field-group:has([data-provider-key-status="openrouter"])'
    await browser.execute((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: 'center', inline: 'nearest' })
    }, keyFieldSelector)
    await saveElementScreenshot(keyFieldSelector, 'settings-plaintext-storage-disabled.png')
  })
})
