import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

describe('Open remote folder — path breadcrumbs', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-remote-folder-breadcrumbs')
    seedSshWorkspaceSettings({ hosts: true })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows an Up control and root breadcrumb in the browse toolbar', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const remoteButton = await $('.projects-open-remote-btn')
    await expect(remoteButton).toBeDisplayed()
    await remoteButton.click()

    const dialog = await $('#remote-folder-dialog')
    await expect(dialog).toBeDisplayed()

    const upBtn = dialog.$('.remote-folder-up')
    await expect(upBtn).toBeDisplayed()
    assert.match(await upBtn.getText(), /Up/)

    const crumbs = dialog.$('.remote-folder-breadcrumbs')
    await browser.waitUntil(async () => (await crumbs.getText()).includes('/'), {
      timeout: 10_000,
      timeoutMsg: 'root breadcrumb did not render',
    })
    const crumbText = await crumbs.getText()
    assert.match(crumbText, /\//)
    // Root crumb is already `/` — never paint a second slash separator after it.
    assert.doesNotMatch(crumbText.replace(/\s+/g, ' '), /\/\s*\/\s+\S/)

    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-breadcrumbs.png')
    await dialog.$('.remote-folder-cancel').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
