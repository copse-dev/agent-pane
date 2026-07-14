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
    seedSshWorkspaceSettings()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows SSH workspace host CRUD and enable toggle', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    const navBtn = $('.settings-nav-btn[data-section="ssh"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const sshSection = settingsSection('ssh')
    await expect(sshSection).toBeDisplayed()
    await expect(sshSection.$('legend=SSH workspaces')).toBeDisplayed()

    const enabledToggle = await sshSection.$('input[name="sshWorkspaceEnabled"]')
    await expect(enabledToggle).toBeExisting()
    assert.equal(await enabledToggle.isSelected(), true)

    const hostRow = await sshSection.$('.ssh-host-row')
    await expect(hostRow).toBeDisplayed()
    assert.match(await hostRow.getText(), /Dev Server/)

    await saveElementScreenshot('#settings-dialog', 'settings-ssh-workspace.png')
  })
})
