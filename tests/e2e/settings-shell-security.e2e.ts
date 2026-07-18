import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('shell security settings', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-shell-security')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('does not expose classifier-based shell auto-run', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="local-models"]').click()
    await expect(dialog.$('input[name="safetyClassifierEnabled"]')).toBeExisting()
    await expect(dialog.$('input[name="postTurnReviewMinChangedLines"]')).toHaveValue('1')
    assert.match(await dialog.getText(), /asked to approve the spend once per chat/)
    assert.equal(await dialog.$('input[name="safetySandboxAllowThreshold"]').isExisting(), false)
    assert.doesNotMatch(await dialog.getText(), /Sandbox auto-allow confidence/)

    await saveElementScreenshot(
      'fieldset:has(input[name="safetyClassifierEnabled"])',
      'settings-shell-security.png',
    )
  })
})
