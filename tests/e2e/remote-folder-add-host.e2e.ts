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

  it('lets you add a host from the open-remote dialog without visiting Settings', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const remoteButton = await $('.projects-open-remote-btn')
    await expect(remoteButton).toBeDisplayed()
    await remoteButton.click()

    const dialog = await $('#remote-folder-dialog')
    await expect(dialog).toBeDisplayed()

    const addForm = await dialog.$('.remote-folder-add-host-form')
    await expect(addForm).toBeDisplayed()
    assert.match(await dialog.$('.remote-folder-status').getText(), /Add a host below/i)

    await dialog.$('input[name="remoteFolderHostLabel"]').setValue('Staging Box')
    await dialog.$('input[name="remoteFolderHostHost"]').setValue('staging.example')
    await dialog.$('input[name="remoteFolderHostUser"]').setValue('deploy')

    const idValue = await dialog.$('input[name="remoteFolderHostId"]').getValue()
    assert.equal(idValue, 'staging-box')

    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-add-host.png')

    await dialog.$('.remote-folder-save-host').click()

    await browser.waitUntil(
      async () => {
        const options = await dialog.$$('.remote-folder-host option')
        if (options.length === 0) return false
        const text = await options[0]?.getText()
        return Boolean(text && text.includes('Staging Box'))
      },
      { timeout: 10_000, timeoutMsg: 'saved host did not appear in the host select' },
    )

    await expect(dialog.$('.remote-folder-add-host-form')).not.toBeDisplayed()
    await expect(dialog.$('.remote-folder-browse')).toBeDisplayed()
  })
})
