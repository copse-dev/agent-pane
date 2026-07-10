import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedDraftPromptFixture } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const DRAFT_TEXT = 'still typing a draft prompt…'

async function clickThreadByTitle(title: string): Promise<void> {
  await browser.execute((threadTitle) => {
    const rows = [...document.querySelectorAll('.chats-list .chat-row')]
    const row = rows.find((r) => r.querySelector('.chat-title')?.textContent === threadTitle)
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, title)
}

describe('draft prompt preservation', () => {
  let usedThreadTitle: string
  let blankThreadTitle: string

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    ;({ usedThreadTitle, blankThreadTitle } = seedDraftPromptFixture(process.cwd()))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps blank threads with drafts and restores composer text on switch', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(blankThreadTitle)

    await setComposerValue(DRAFT_TEXT)
    await clickThreadByTitle(usedThreadTitle)
    await expect($('.chat-row.selected .chat-title')).toHaveText(usedThreadTitle)
    await expect($('.messages-list .msg-user')).toHaveText('hello from used thread')

    const rowsAfterSwitch = await $$('.chats-list .chat-row')
    await expect(rowsAfterSwitch).toBeElementsArrayOfSize(2)

    await clickThreadByTitle(blankThreadTitle)
    await expect($('.chat-row.selected .chat-title')).toHaveText(blankThreadTitle)
    await expect($('.prompt-input')).toHaveText(DRAFT_TEXT)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'draft-prompt-restored.png'))

    await $('.project-new-thread-btn').click()
    await expect($('.prompt-input')).toHaveText('')

    // Creating a new thread appends its row asynchronously (store emit →
    // re-render), so snapshotting `$$` right after the click races the insert
    // and sees the pre-insert count — the #345 flake (expected 3, received 2).
    // Poll until the row lands before snapshotting.
    await browser.waitUntil(async () => (await $$('.chats-list .chat-row')).length === 3, {
      timeout: 10_000,
      timeoutMsg: 'expected 3 chat rows after creating a new thread',
    })
    const rowsAfterNew = await $$('.chats-list .chat-row')
    const titles = await rowsAfterNew.map((row) => row.$('.chat-title').getText())
    await expect(titles.filter((t) => t === blankThreadTitle).length).toBe(2)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'draft-prompt-new-thread.png'))
  })
})
