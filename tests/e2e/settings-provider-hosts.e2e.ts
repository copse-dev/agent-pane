import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
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

  it('surfaces approved provider hosts controls in Settings → Permissions', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="permissions"]').click()

    const approval = dialog.$('input[name="providerAllowUserApproval"]')
    const hosts = dialog.$('textarea[name="approvedProviderHosts"]')
    await expect(approval).toBeExisting()
    await expect(hosts).toBeExisting()
    assert.equal(await approval.isSelected(), true)
    assert.match(await dialog.getText(), /Allowed provider addresses/)
    assert.match(await dialog.getText(), /Ask before allowing a new provider address/)

    await saveElementScreenshot(
      'fieldset:has(textarea[name="approvedProviderHosts"])',
      'settings-provider-hosts.png',
    )
  })

  it('shows a provider-host approval above the open settings dialog', async () => {
    const settings = $('#settings-dialog')
    await expect(settings).toBeDisplayed()

    await browser.execute(() => {
      void window.api.settings
        .saveExtraProvider({
          slug: 'poolside',
          label: 'Poolside',
          baseUrl: 'https://api.poolside.ai/v1',
          models: [{ id: 'malibu' }],
        })
        .catch(() => undefined)
    })

    const approval = $('#approval-dialog')
    await approval.waitForDisplayed({ timeout: 15_000 })
    await expect(approval.$('.approval-heading')).toHaveText('Allow model provider host?')
    await expect(approval.$('.approval-body')).toHaveText(
      expect.stringContaining('api.poolside.ai'),
    )
    const openDialogs = await browser.execute(() => ({
      settings: document.querySelector<HTMLDialogElement>('#settings-dialog')?.open ?? false,
      approval: document.querySelector<HTMLDialogElement>('#approval-dialog')?.open ?? false,
    }))
    assert.deepEqual(openDialogs, { settings: true, approval: true })

    await saveAppScreenshot('settings-provider-host-approval.png')

    await approval.$('.approval-reject').click()
    await expect(approval).not.toBeDisplayed()
    await expect(settings).toBeDisplayed()
  })
})
