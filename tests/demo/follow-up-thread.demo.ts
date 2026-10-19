import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('create follow-up thread', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-thread-changes')
    await $('.chats-list .chat-row').waitForExist({ timeout: 30_000 })
    await browser.setWindowSize(1280, 900)
  })

  it('offers the item in the thread menu and opens a linked thread with the original attached as a chip', async () => {
    const rows = await $$('.chats-list .chat-row')
    let source: WebdriverIO.Element | undefined
    for (const row of rows) {
      if ((await row.$('.chat-title').getText()) === 'Refactor auth') source = row
    }
    if (!source) throw new Error('Missing "Refactor auth" row')
    const sourceId = await source.getAttribute('data-thread-id')
    await source.$('.chat-menu-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await saveAppScreenshot('follow-up-thread-menu.png')
    await $('.context-menu-item*=Create follow-up thread').click()

    await browser.waitUntil(
      async () => (await $('.chat-row.selected').getAttribute('data-thread-id')) !== sourceId,
      { timeout: 10_000, timeoutMsg: 'expected the follow-up thread to become active' },
    )
    await expect($('.chat-row.selected .chat-title')).toHaveText('Follow-up: Refactor auth')
    await expect($('.prompt-input .inline-thread-chip')).toHaveText(
      expect.stringContaining('Refactor auth'),
    )
    await saveAppScreenshot('follow-up-thread-created.png')
  })
})
