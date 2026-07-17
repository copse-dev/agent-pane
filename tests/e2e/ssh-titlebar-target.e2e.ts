import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

describe('SSH status chrome without lightning emoji', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Host is intentionally unreachable so restore surfaces the disconnect banner.
    seedEmptyProject(process.cwd(), 'e2e-ssh-titlebar-target', { sshHost: 'dev' })
    seedSshWorkspaceSettings({ hosts: true })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the SSH disconnect banner without a lightning emoji', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const banner = await $('#ssh-status-banner')
    await banner.waitForExist({ timeout: 15_000 })
    await expect(banner).toBeDisplayed()
    const text = await banner.getText()
    assert.match(text, /SSH connection/)
    assert.doesNotMatch(text, /⚡/)
    assert.equal(await banner.$$('.ssh-status-icon').length, 0)

    await saveElementScreenshot('#ssh-status-banner', 'ssh-status-banner-no-lightning.png')
  })
})
