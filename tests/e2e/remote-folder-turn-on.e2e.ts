import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { useLocalSshConfig, type LocalSshConfig } from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedSshWorkspaceSettings,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

async function sshWorkspacesOn(): Promise<unknown> {
  return browser.execute(async () => window.api.settings.get('sshWorkspaceEnabled'))
}

async function openRemoteProject(): Promise<WebdriverIO.Element> {
  const addProjectButton = $('.projects-add-btn')
  await expect(addProjectButton).toHaveAttribute(
    'data-tooltip',
    'New project, open a folder, or connect remotely',
  )
  await addProjectButton.click()
  await $('.context-menu-item*=Open remote project').click()
  const dialog = await $('#remote-folder-dialog').getElement()
  await expect(dialog).toBeDisplayed()
  return dialog
}

describe('Open remote folder — turning SSH workspaces on where they are used', () => {
  let sshConfig: LocalSshConfig

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // No config hosts, so the dialog lands on its add-host form once turned on.
    sshConfig = useLocalSshConfig('')
    seedEmptyProject(seedStableWorkspace(), 'e2e-remote-folder-turn-on')
    seedSshWorkspaceSettings({ enabled: false, hosts: false })
    await browser.reloadSession()
  })

  after(() => {
    sshConfig.remove()
    resetUserData()
  })

  it('asks before anything connects, and declining leaves SSH workspaces off', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    assert.equal(await sshWorkspacesOn(), false)

    const dialog = await openRemoteProject()
    const consent = dialog.$('.ssh-consent')
    await consent.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.ssh-consent-title')).toHaveText('Turn on SSH workspaces?')
    assert.match(await dialog.$('.ssh-consent-body').getText(), /applies no sandbox there/)
    // Nothing about hosts or folders is shown, or reached, until the user agrees.
    await expect(dialog.$('.remote-folder-picker')).not.toBeDisplayed()
    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-turn-on.png')

    await dialog.$('.ssh-consent-cancel').click()
    await expect(dialog).not.toBeDisplayed()
    assert.equal(await sshWorkspacesOn(), false)
  })

  it('turns them on in one click and carries on to choosing a host', async () => {
    // Stands on its own: CI's burn-in also runs every test alone.
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    const dialog = await openRemoteProject()
    await dialog.$('.ssh-consent-turn-on').click()

    await dialog.$('.remote-folder-add-host-form').waitForDisplayed({ timeout: 10_000 })
    assert.equal(await sshWorkspacesOn(), true)
    await expect(dialog.$('.ssh-consent')).not.toBeExisting()
    await expect(dialog.$('.remote-folder-picker')).toBeDisplayed()

    await dialog.$('.remote-folder-cancel').click()
    await expect(dialog).not.toBeDisplayed()

    // Once on, the dialog goes straight to choosing a host.
    const again = await openRemoteProject()
    await again.$('.remote-folder-add-host-form').waitForDisplayed({ timeout: 10_000 })
    await expect(again.$('.ssh-consent')).not.toBeExisting()
    await again.$('.remote-folder-cancel').click()
  })
})
