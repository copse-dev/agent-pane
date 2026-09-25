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
    // The next-step hint leads the form it refers to, and the empty host
    // picker shows a placeholder instead of a blank box (#3065).
    const emptyState = await browser.execute(() => {
      const root = document.querySelector('#remote-folder-dialog')
      const hint = root?.querySelector<HTMLElement>('.remote-folder-add-host-hint')
      const firstField = root?.querySelector<HTMLElement>('.remote-folder-add-host-form label')
      const select = root?.querySelector<HTMLSelectElement>('.remote-folder-host')
      const status = root?.querySelector<HTMLElement>('.remote-folder-status')
      if (!hint || !firstField || !select || !status) return null
      const selected = select.selectedOptions[0]
      return {
        hint: hint.textContent.trim(),
        hintAboveForm:
          hint.getBoundingClientRect().bottom <= firstField.getBoundingClientRect().top,
        selectedText: selected?.textContent.trim() ?? '',
        selectedDisabled: selected?.disabled === true,
        status: status.textContent.trim(),
      }
    })
    assert.ok(emptyState, 'remote folder empty state must render')
    assert.match(emptyState.hint, /No SSH hosts yet\. Add one/)
    assert.equal(emptyState.hintAboveForm, true, 'the next-step hint sits above the form')
    assert.equal(emptyState.selectedText, 'No hosts yet')
    assert.equal(emptyState.selectedDisabled, true, 'the placeholder cannot be chosen')
    assert.equal(emptyState.status, '', 'no duplicate hint under the form')

    await dialog.$('input[name="remoteFolderHostLabel"]').setValue('Staging Box')
    await dialog.$('input[name="remoteFolderHostHost"]').setValue('staging.example')
    await dialog.$('input[name="remoteFolderHostUser"]').setValue('deploy')

    await browser.waitUntil(
      async () => (await dialog.$('input[name="remoteFolderHostId"]').getValue()) === 'staging-box',
      { timeout: 5_000, timeoutMsg: 'host id did not auto-slugify from the label' },
    )

    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-add-host.png')
    // Save host is the filled primary; Import is a quiet kit button (#3065).
    await expect(dialog.$('.remote-folder-save-host')).toHaveElementClass('ui-btn-primary')
    await expect(dialog.$('.remote-folder-import-config')).toHaveElementClass('ui-btn')
    await dialog.$('.remote-folder-cancel').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
