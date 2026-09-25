import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'
import { assertErrorColor, assertKitButtonChrome } from './helpers/ui-kit-style.ts'

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

    // The fixture host is unreachable, so browsing fails. The dialog must say
    // why in the error hue, without Electron's IPC channel wrapping.
    const errorStatus = dialog.$('.remote-folder-status [data-status-kind="error"]')
    await errorStatus.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'unreachable host did not surface an error status',
    })
    const errorText = await errorStatus.getText()
    assert.ok(errorText.trim().length > 0, 'error status must carry the failure reason')
    assert.doesNotMatch(errorText, /Error invoking remote method|ssh-workspace:connect/)
    await assertErrorColor('#remote-folder-dialog .remote-folder-status .ui-inline-status')

    // Every action is a kit button with visible chrome, not a bare word.
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-open', 'primary')
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-cancel', 'secondary')
    await assertKitButtonChrome('#remote-folder-dialog .remote-folder-add-host-btn', 'secondary')

    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-breadcrumbs.png')
    await dialog.$('.remote-folder-cancel').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
