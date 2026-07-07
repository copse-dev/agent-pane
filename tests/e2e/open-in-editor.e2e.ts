import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// COPSE_PANEL_MOCK_EDITORS (set in wdio.conf.ts) reports these three as installed.
describe('open in editor dropdown', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-open-in-editor')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the split control defaulting to the first detected editor', async () => {
    await $('.titlebar').waitForExist({ timeout: 30_000 })

    const control = await $('.open-in-editor')
    await expect(control).toBeDisplayed()

    // No last-used editor persisted, so the primary defaults to the first
    // detected (VS Code in the mock's known-editor order).
    await expect($('.open-in-editor-label')).toHaveText('Open in Visual Studio Code')

    // More than one editor detected, so the caret is available.
    await expect($('.open-in-editor-caret')).toBeDisplayed()

    await $('.titlebar').saveScreenshot(join(SCREENSHOT_DIR, 'open-in-editor-collapsed.png'))
  })

  it('lists every detected editor when the caret is clicked', async () => {
    const menu = await $('.open-in-editor-menu')
    await expect(menu).not.toBeDisplayed()

    await $('.open-in-editor-caret').click()
    await expect(menu).toBeDisplayed()

    const options = await $$('.open-in-editor-option')
    await expect(options).toBeElementsArrayOfSize(3)
    await expect(await $('[data-editor-id="vscode"]')).toHaveText('Open in Visual Studio Code')
    await expect(await $('[data-editor-id="cursor"]')).toHaveText('Open in Cursor')
    await expect(await $('[data-editor-id="zed"]')).toHaveText('Open in Zed')

    await $('.titlebar').saveScreenshot(join(SCREENSHOT_DIR, 'open-in-editor-open.png'))
  })

  it('closes the menu after picking an editor', async () => {
    // Menu is open from the previous step; picking an entry launches (a no-op
    // under the mock) and closes the menu.
    await $('[data-editor-id="cursor"]').click()
    await expect($('.open-in-editor-menu')).not.toBeDisplayed()

    // The picked editor becomes the sticky default for the primary button.
    await expect($('.open-in-editor-label')).toHaveText('Open in Cursor')
  })
})
