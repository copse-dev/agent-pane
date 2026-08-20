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
    // A bare timeout here says only "no banner", which is the one thing already
    // known. The banner is gated on `activeSshHostId` — an `activeProjectId`
    // that resolves to a project carrying an `sshHost` — and rendered from an
    // SSH connection event, so report all three when it does not appear.
    try {
      await banner.waitForExist({ timeout: 15_000 })
    } catch (error) {
      const state = await browser.execute(() => ({
        projectRows: [...document.querySelectorAll('.project-row')].map(
          (row) => row.getAttribute('title') ?? '',
        ),
        titlebar: document.querySelector('.workspace-name')?.textContent?.trim() ?? null,
      }))
      const ssh = await browser.execute(() => window.api.sshWorkspace.getStates())
      throw new Error(
        `SSH disconnect banner never rendered. dom=${JSON.stringify(state)} ssh=${JSON.stringify(ssh)}`,
        { cause: error },
      )
    }
    await expect(banner).toBeDisplayed()
    const text = await banner.getText()
    assert.match(text, /SSH connection/)
    assert.doesNotMatch(text, /⚡/)
    assert.equal(await banner.$$('.ssh-status-icon').length, 0)

    await saveElementScreenshot('#ssh-status-banner', 'ssh-status-banner-no-lightning.png')
  })
})
