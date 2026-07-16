import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

function settingsSection(section: 'ssh') {
  return $(`.settings-section[data-section="${section}"]`)
}

describe('SSH settings section', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-ssh')
    // Start disabled so we can prove the live toggle reveals "+ Remote"
    // without clicking Save.
    seedSshWorkspaceSettings({ enabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows SSH workspace host CRUD and enable toggle under Settings → SSH', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const remoteBefore = $('.projects-open-remote-btn')
    assert.equal(await remoteBefore.isDisplayed(), false)

    await $('[aria-label="Settings"]').click()

    const navBtn = $('.settings-nav-btn[data-section="ssh"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const sshSection = settingsSection('ssh')
    await expect(sshSection).toBeDisplayed()
    await expect(sshSection.$('legend=SSH workspaces')).toBeDisplayed()

    const enabledToggle = await sshSection.$('input[name="sshWorkspaceEnabled"]')
    await expect(enabledToggle).toBeExisting()
    assert.equal(await enabledToggle.isSelected(), false)

    const hostRow = await sshSection.$('.ssh-host-row')
    await expect(hostRow).toBeDisplayed()
    assert.match(await hostRow.getText(), /Dev Server/)

    await enabledToggle.click()
    assert.equal(await enabledToggle.isSelected(), true)

    await saveElementScreenshot('#settings-dialog', 'settings-ssh-workspace.png')

    // Cancel closes without the form Save path — the live toggle must still
    // have emitted settings_changed so the projects pane shows "+ Remote".
    await $('#settings-cancel').click()
    const remoteAfter = $('.projects-open-remote-btn')
    await expect(remoteAfter).toBeDisplayed()
    await saveElementScreenshot('#pane-projects', 'ssh-projects-pane-after-enable.png')
  })
})
