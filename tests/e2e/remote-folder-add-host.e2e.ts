import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { useLocalSshConfig, type LocalSshConfig } from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'
import { assertErrorColor, assertKitButtonChrome } from './helpers/ui-kit-style.ts'

describe('Open remote folder — add host inline', () => {
  let sshConfig: LocalSshConfig

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // The empty state below depends on there being no ~/.ssh/config hosts to
    // offer, whatever the runner's own file holds.
    sshConfig = useLocalSshConfig('')
    seedEmptyProject(process.cwd(), 'e2e-remote-folder-add-host')
    seedSshWorkspaceSettings({ hosts: false })
    await browser.reloadSession()
  })

  after(() => {
    sshConfig.remove()
    resetUserData()
  })

  it('shows an inline add-host form when no SSH hosts are configured', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const addProjectButton = await $('.projects-add-btn').getElement()
    await expect(addProjectButton).toHaveAttribute(
      'data-tooltip',
      'New project, open a folder, or connect remotely',
    )
    await addProjectButton.click()
    const remoteMenuItem = await $('.context-menu-item*=Open remote project').getElement()
    await expect(remoteMenuItem).toBeDisplayed()
    await remoteMenuItem.click()

    const dialog = await $('#remote-folder-dialog').getElement()
    await expect(dialog).toBeDisplayed()

    const addForm = await dialog.$('.remote-folder-add-host-form').getElement()
    await expect(addForm).toBeDisplayed()
    await expect(dialog.$('.remote-folder-add-host-btn')).not.toBeDisplayed()
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

    const addHostFields = await browser.execute(() => {
      const root = document.querySelector('#remote-folder-dialog')
      return Array.from(
        root?.querySelectorAll<HTMLInputElement>('.remote-folder-add-host-form input') ?? [],
      ).map((field) => ({
        name: field.name,
        type: field.type,
        maxWidth: getComputedStyle(field).maxWidth,
      }))
    })
    // The same fields as Settings and the Desktop pane: no id to invent, and
    // agent forwarding is offered here too.
    assert.deepEqual(
      addHostFields.map((field) => field.name),
      [
        'sshHostLabel',
        'sshHostHost',
        'sshHostUser',
        'sshHostPort',
        'sshHostIdentity',
        'sshHostForwardAgent',
      ],
    )
    for (const field of addHostFields.filter((entry) => entry.type !== 'checkbox')) {
      assert.equal(field.type, 'text', `${field.name} uses text input semantics`)
      assert.equal(field.maxWidth, '360px', `${field.name} uses the shared SSH field width cap`)
    }

    await dialog.$('input[name="sshHostLabel"]').setValue('Staging Box')
    await dialog.$('input[name="sshHostHost"]').setValue('staging.example')
    await dialog.$('input[name="sshHostUser"]').setValue('deploy')

    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-cancel-add', 'secondary')
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-save-host', 'primary')
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-cancel', 'secondary')

    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-add-host.png')

    // A draft the parser rejects stays in the form and reports in the error hue.
    await dialog.$('input[name="sshHostPort"]').setValue('22garbage')
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
