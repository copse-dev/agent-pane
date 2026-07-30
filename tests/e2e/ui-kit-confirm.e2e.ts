import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-ui-kit-confirm'

/**
 * Visual eval for the first UI-kit slice: confirm dialog buttons/actions use
 * `.ui-btn*` + `<copse-ui-actions>` instead of screen-local button CSS.
 */
describe('UI kit confirm dialog', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
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
              content: 'Stay around.',
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
          title: 'Delete candidate',
          status: 'idle',
          messages: [
            {
              id: 'msg-b',
              role: 'user',
              content: 'Candidate for delete.',
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
    await expect($('.chat-row.selected .chat-title')).toHaveText('Delete candidate')
  })

  after(() => {
    resetUserData()
  })

  it('renders kit buttons in the confirm dialog', async function () {
    this.timeout(60_000)

    await browser.waitUntil(async () => (await $$('.chats-list .chat-row')).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'expected two seeded chat rows',
    })

    // Dispatch in-page (same pattern as file-search-palette): Electron may
    // swallow a real Ctrl/Cmd+W before the renderer shortcut handler runs.
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'w', metaKey: true, ctrlKey: true, bubbles: true }),
      )
    })

    const dialog = await $('#confirm-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(await dialog.$('.confirm-dialog-message')).toHaveText('Delete this thread?')
    await expect(await dialog.$('copse-ui-actions.ui-actions')).toExist()
    await expect(await dialog.$('button.ui-btn.ui-btn-secondary.confirm-dialog-cancel')).toHaveText(
      'Cancel',
    )
    await expect(await dialog.$('button.ui-btn.ui-btn-danger.confirm-dialog-confirm')).toHaveText(
      'Delete',
    )

    await saveElementScreenshot('#confirm-dialog', 'ui-kit-confirm-dialog.png')

    await dialog.$('.confirm-dialog-cancel').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
