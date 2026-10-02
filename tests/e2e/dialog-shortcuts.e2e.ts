import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-dialog-shortcuts'

describe('dialog keyboard shortcuts', () => {
  before(async function () {
    this.timeout(90_000)
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: 'thread-b',
      [`threads:${PROJECT_ID}`]: [
        {
          id: 'thread-a',
          title: 'Keep me',
          status: 'idle',
          messages: [
            {
              id: 'msg-a',
              role: 'user',
              content: 'Keep this conversation.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'thread-b',
          title: 'Active conversation',
          status: 'idle',
          messages: [
            {
              id: 'msg-b',
              role: 'user',
              content: 'Keep this active conversation too.',
              toolCalls: [],
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      ],
    })
    seedE2eViewport()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('does not delete the active thread while Settings is open', async () => {
    await browser.waitUntil(async () => (await $$('.chats-list .chat-row')).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'expected two seeded chat rows',
    })
    await expect($('.chat-row.selected .chat-title')).toHaveText('Active conversation')

    await $('[aria-label="Settings"]').click()
    const settings = $('#settings-dialog')
    await settings.waitForDisplayed({ timeout: 10_000 })

    // Dispatch in-page: Electron may consume a physical Cmd/Ctrl+W as the native
    // File ▸ Close accelerator before the renderer shortcut handler sees it.
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'w', metaKey: true, ctrlKey: true, bubbles: true }),
      )
    })

    await expect(settings).toBeDisplayed()
    await expect($('#confirm-dialog')).not.toBeDisplayed()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Active conversation')
    expect(await $$('.chats-list .chat-row')).toHaveLength(2)
    await saveElementScreenshot('#settings-dialog', 'cmd-w-settings-dialog-safe.png')
  })
})
