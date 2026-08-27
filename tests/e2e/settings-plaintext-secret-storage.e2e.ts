import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/**
 * Visual proof for the default-off plaintext secret policy. A headless Linux
 * host may still provide Secret Service, so this session points its real OS
 * keyring adapter at an absent D-Bus socket. Electron safeStorage is already
 * unavailable in the Linux E2E configuration.
 */
describe('settings plaintext secret storage', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({
      COPSE_ALLOW_PLAINTEXT_SECRETS: undefined,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/copse-e2e-no-secret-service.sock',
    })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-plaintext-storage-disabled')
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({
      COPSE_ALLOW_PLAINTEXT_SECRETS: undefined,
      DBUS_SESSION_BUS_ADDRESS: undefined,
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
    await keyInput.setValue('sk-or-v1-e2e-plaintext-policy')
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

    await saveElementScreenshot('.provider-form', 'settings-plaintext-storage-disabled.png')
  })
})
