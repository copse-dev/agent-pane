import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'
import { saveThreePaneScreenshot } from './helpers/screenshot.ts'

describe('new thread keeps the side/bottom panel open', () => {
  before(async () => {
    resetUserData()
    seedToolDisplayFixture(process.cwd())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps #pane-files visible after creating a new thread', async () => {
    const pane = await $('#pane-files')

    // Open the right panel (explorer) from the titlebar.
    await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    await pane.waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Explorer"]')).toHaveElementClass('is-active')

    const rowsBefore = await $$('.chats-list .chat-row')
    await expect(rowsBefore).toBeElementsArrayOfSize(1)
    await saveThreePaneScreenshot('new-thread-panel-before.png')

    // Create a new thread from the expanded project row.
    await $('.project-new-thread-btn').click()

    // A fresh blank thread is added and selected.
    const rowsAfter = await $$('.chats-list .chat-row')
    await expect(rowsAfter).toBeElementsArrayOfSize(2)
    await expect($('.chat-row.selected .chat-title')).toHaveText('New Thread')

    // The panel stays open in the same mode on the new thread.
    await expect(pane).toBeDisplayed()
    await expect($('.right-panel-tab[aria-label="Explorer"]')).toHaveElementClass('is-active')
    await saveThreePaneScreenshot('new-thread-panel-after.png')
  })
})
