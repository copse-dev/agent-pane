import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-panel-toggle-project'

describe('right panel toggle', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens and closes the files panel from the titlebar', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const pane = await $('#pane-files')
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')

    await expect(pane).not.toBeDisplayed()

    await panelBtn.click()
    await pane.waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Explorer"]')).toHaveElementClass('is-active')

    await panelBtn.click()
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected pane-files to hide after second toggle',
    })
  })

  it('opens terminal mode from the titlebar', async () => {
    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()

    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Terminal"]')).toHaveElementClass('is-active')
    await $('.terminal-container .xterm').waitForExist({ timeout: 15_000 })
  })
})
