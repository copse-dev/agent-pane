import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { assertNoErrorToasts, collectErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/**
 * Regression for the `settings:setSecurity` save crash: the schema required
 * `cursorHooksEnabled` but no renderer caller ever sent it, so clicking Save
 * surfaced an "Unexpected error … expected boolean, received undefined" toast.
 */
describe('settings save', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-save')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('saves the settings dialog without an error toast', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await expect($('#settings-dialog')).toBeDisplayed()

    await $('#settings-dialog button[type="submit"]').click()

    // Dialog hides on a successful save; a failed setSecurity leaves it visible.
    await $('#settings-dialog').waitForDisplayed({ timeout: 15_000, reverse: true })

    const toasts = await collectErrorToasts()
    await assertNoErrorToasts('settings save')

    // Re-open to prove state persisted and capture a screenshot of the saved dialog.
    await $('[aria-label="Settings"]').click()
    await expect($('#settings-dialog')).toBeDisplayed()
    await saveElementScreenshot('#settings-dialog', 'settings-save-no-error.png')

    expect(toasts).toEqual([])
  })
})
