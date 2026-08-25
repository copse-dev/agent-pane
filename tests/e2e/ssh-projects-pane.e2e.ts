import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
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

  it('aligns sidebar actions and includes remote projects in the main add menu', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const projectsPane = await $('#pane-projects')
    await expect(projectsPane).toBeDisplayed()
    await expect($('.projects-open-remote-btn')).not.toBeExisting()

    const newThreadButton = await $('.project-new-thread-btn')
    await expect(newThreadButton).toBeDisplayed()
    await newThreadButton.click()
    const threadRow = await $('.chat-row')
    await expect(threadRow).toBeDisplayed()
    await threadRow.moveTo()

    const actionCenters = await browser.execute(() =>
      ['.projects-add-btn', '.project-new-thread-btn', '.chat-delete'].map((selector) => {
        const action = document.querySelector<HTMLElement>(selector)
        if (!action) throw new Error(`Missing sidebar action: ${selector}`)
        const rect = action.getBoundingClientRect()
        return rect.left + rect.width / 2
      }),
    )
    assert.ok(
      Math.max(...actionCenters) - Math.min(...actionCenters) <= 1,
      `expected sidebar actions to share an x-axis, got ${actionCenters.join(', ')}`,
    )

    await saveElementScreenshot('#pane-projects', 'ssh-projects-pane.png')

    const addButton = await $('.projects-add-btn')
    await expect(addButton).toHaveAttribute('aria-label', 'Add project')
    await expect(addButton).toHaveAttribute(
      'data-tooltip',
      'New project, open a folder, or connect remotely',
    )
    await addButton.click()

    const menu = await $('.context-menu')
    await expect(menu).toBeDisplayed()
    const labels = await $$('.context-menu-item').map((item) => item.getText())
    assert.deepEqual(labels, ['New project', 'Open folder', 'Open remote project', 'New group'])
    await saveAppScreenshot('ssh-project-add-menu.png')
  })
})
