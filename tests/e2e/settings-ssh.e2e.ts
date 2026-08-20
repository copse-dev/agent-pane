import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

function settingsSection(section: 'ssh') {
  return $(`.settings-section[data-section="${section}"]`)
}

describe('SSH settings section', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-ssh')
    // Start disabled so we can prove the live toggle adds the remote action
    // to the project menu without clicking Save.
    seedSshWorkspaceSettings({ enabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows SSH workspace host CRUD and enable toggle under Settings → SSH', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const addProjectButton = $('.projects-add-btn')
    await expect(addProjectButton).toHaveAttribute('data-tooltip', 'New project or open a folder')
    await addProjectButton.click()
    await expect($('.context-menu-item*=Open remote project')).not.toBeExisting()
    await browser.keys('Escape')

    await $('[aria-label="Settings"]').click()

    const navBtn = $('.settings-nav-btn[data-section="ssh"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const sshSection = settingsSection('ssh')
    await expect(sshSection).toBeDisplayed()
    await expect(sshSection.$('legend=SSH workspaces')).toBeDisplayed()
    const closeButton = $('#settings-close')
    await expect(closeButton.$('svg[data-icon="close"]')).toExist()
    assert.equal(await closeButton.getText(), '')

    const enabledToggle = await sshSection.$('input[name="sshWorkspaceEnabled"]')
    await expect(enabledToggle).toBeExisting()
    assert.equal(await enabledToggle.isSelected(), false)

    const hostRow = await sshSection.$('.ssh-host-row')
    await expect(hostRow).toBeDisplayed()
    assert.match(await hostRow.getText(), /Dev Server/)

    const editBtn = await hostRow.$('.ssh-host-edit')
    const removeBtn = await hostRow.$('.ssh-host-delete')
    await expect(editBtn).toBeDisplayed()
    await expect(removeBtn).toBeDisplayed()
    // Guard the EditRemove jam: actions must be separate flex items with gap.
    const editBox = await editBtn.getLocation()
    const editSize = await editBtn.getSize()
    const removeBox = await removeBtn.getLocation()
    assert.ok(
      removeBox.x >= editBox.x + editSize.width + 8,
      `expected ≥8px between Edit and Remove, got remove.x=${String(removeBox.x)} edit.right=${String(editBox.x + editSize.width)}`,
    )

    await enabledToggle.click()
    assert.equal(await enabledToggle.isSelected(), true)

    await saveElementScreenshot('#settings-dialog', 'settings-ssh-workspace.png')

    // Cancel closes without the form Save path — the live toggle must still
    // have emitted settings_changed so the project menu gains its remote action.
    await $('#settings-cancel').click()
    await expect(addProjectButton).toHaveAttribute(
      'data-tooltip',
      'New project, open a folder, or connect remotely',
    )
    await addProjectButton.click()
    await expect($('.context-menu-item*=Open remote project')).toBeDisplayed()
    await saveAppScreenshot('ssh-projects-pane-after-enable.png')
  })
})
