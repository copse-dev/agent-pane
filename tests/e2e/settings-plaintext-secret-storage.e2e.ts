import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/**
 * Visual proof for the default-off plaintext secret policy. Linux e2e runs
 * without an OS keyring by design; macOS has Keychain and cannot reach this
 * supported state without a test-only product backdoor, so it skips here.
 */
describe('settings plaintext secret storage', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_ALLOW_PLAINTEXT_SECRETS: undefined })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-plaintext-storage-disabled')
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_ALLOW_PLAINTEXT_SECRETS: undefined })
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
        (candidate) => candidate.textContent?.trim() === 'OpenAI',
      )
      chip?.click()
      return Boolean(chip)
    })
    assert.equal(selected, true, 'expected an OpenAI provider chip')

    const form = dialog.$('.provider-form')
    const keyInput = form.$('input[type="password"]')
    await keyInput.waitForDisplayed({ timeout: 10_000 })
    await keyInput.setValue('sk-e2e-plaintext-policy')
    await dialog.$('button[type="submit"]').click()

    const status = form.$('[data-provider-key-status="openai"]')
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
