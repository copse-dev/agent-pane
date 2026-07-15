import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

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

    const remoteButton = await $('.projects-open-remote-btn')
    await expect(remoteButton).toBeDisplayed()
    await remoteButton.click()

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

    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-add-host.png')
    await dialog.$('.remote-folder-cancel').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
