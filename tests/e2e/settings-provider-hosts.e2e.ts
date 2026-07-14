import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('provider host allowlist settings', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-provider-hosts')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('surfaces approved provider hosts controls in Settings → General', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="general"]').click()

    const approval = dialog.$('input[name="providerAllowUserApproval"]')
    const hosts = dialog.$('textarea[name="approvedProviderHosts"]')
    await expect(approval).toBeExisting()
    await expect(hosts).toBeExisting()
    assert.equal(await approval.isSelected(), true)
    assert.match(await dialog.getText(), /Approved provider hosts/)
    assert.match(await dialog.getText(), /Ask before allowing new model provider hosts/)

    await saveElementScreenshot(
      'fieldset:has(textarea[name="approvedProviderHosts"])',
      'settings-provider-hosts.png',
    )
  })
})
