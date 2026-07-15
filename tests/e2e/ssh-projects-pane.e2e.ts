import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

describe('SSH remote project entry point', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-ssh-projects-pane')
    seedSshWorkspaceSettings()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the remote-project action when SSH workspaces are enabled', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const projectsPane = await $('#pane-projects')
    await expect(projectsPane).toBeDisplayed()
    const remoteButton = await $('.projects-open-remote-btn')
    await expect(remoteButton).toBeDisplayed()
    await expect(remoteButton).toHaveText('+ Remote')
    await expect(remoteButton).toHaveAttribute('aria-label', 'Open remote project')

    await saveElementScreenshot('#pane-projects', 'ssh-projects-pane.png')
  })
})
