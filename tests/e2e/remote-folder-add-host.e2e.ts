import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'
import { assertErrorColor, assertKitButtonChrome } from './helpers/ui-kit-style.ts'

describe('Open remote folder — add host inline', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-remote-folder-add-host')
    seedSshWorkspaceSettings({ hosts: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows an inline add-host form when no SSH hosts are configured', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const addProjectButton = await $('.projects-add-btn')
    await expect(addProjectButton).toHaveAttribute(
      'data-tooltip',
      'New project, open a folder, or connect remotely',
    )
    await addProjectButton.click()
    const remoteMenuItem = await $('.context-menu-item*=Open remote project')
    await expect(remoteMenuItem).toBeDisplayed()
    await remoteMenuItem.click()

    const dialog = await $('#remote-folder-dialog')
    await expect(dialog).toBeDisplayed()

    const addForm = await dialog.$('.remote-folder-add-host-form')
    await expect(addForm).toBeDisplayed()
    await expect(dialog.$('.remote-folder-add-host-btn')).not.toBeDisplayed()
    await expect(dialog.$('.remote-folder-import-config')).toBeDisplayed()
    await expect(dialog.$('.remote-folder-save-host')).toBeDisplayed()
    assert.match(await dialog.$('.remote-folder-status').getText(), /Add a host below/i)

    await dialog.$('input[name="remoteFolderHostLabel"]').setValue('Staging Box')
    await dialog.$('input[name="remoteFolderHostHost"]').setValue('staging.example')
    await dialog.$('input[name="remoteFolderHostUser"]').setValue('deploy')

    await browser.waitUntil(
      async () => (await dialog.$('input[name="remoteFolderHostId"]').getValue()) === 'staging-box',
      { timeout: 5_000, timeoutMsg: 'host id did not auto-slugify from the label' },
    )

    // Import is a quiet (ghost) kit button beside the outlined Cancel (#3078).
    await expect(dialog.$('.remote-folder-import-config')).toHaveElementClass('ui-btn-ghost')
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-cancel-add', 'secondary')
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-save-host', 'primary')
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-cancel', 'secondary')

    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-add-host.png')

    // A draft the parser rejects stays in the form and reports in the error hue.
    await dialog.$('input[name="remoteFolderHostPort"]').setValue('22garbage')
    await dialog.$('.remote-folder-save-host').click()
    const errorStatus = dialog.$('.remote-folder-status [data-status-kind="error"]')
    await errorStatus.waitForExist({ timeout: 5_000 })
    await expect(errorStatus).toHaveText('Port must be a whole number from 1 to 65535.')
    await assertErrorColor('#remote-folder-dialog .remote-folder-status .ui-inline-status')
    await expect(addForm).toBeDisplayed()
    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-add-host-error.png')
    await dialog.$('.remote-folder-cancel').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
