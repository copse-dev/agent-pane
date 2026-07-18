import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-shell-mention'

describe('@shell mention', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('lists the open Shells tab and attaches a chip on select', async function () {
    this.timeout(90_000)

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })

    // Focus the composer and open the mention picker on @shell.
    await setComposerValue('@shell')

    const shellItem = await $('.mention-picker .mention-item-shell')
    await shellItem.waitForDisplayed({ timeout: 10_000 })
    await expect($('.mention-item-shell svg.mention-shell-icon')).toBeExisting()

    await saveAppScreenshot('shell-mention-picker.png')

    await shellItem.click()
    const chip = await $('.attachment-chip.shell-chip')
    await chip.waitForDisplayed({ timeout: 10_000 })
    await expect(chip.$('svg.shell-chip-icon')).toBeExisting()
    await expect($('.mention-picker')).not.toBeDisplayed()

    await saveAppScreenshot('shell-mention-chip.png')
  })
})
