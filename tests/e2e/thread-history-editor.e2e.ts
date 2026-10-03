import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-thread-history-editor'
const THREAD_ID = 'editable-thread'

function seedThread(): void {
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    expandedProjectId: PROJECT_ID,
    activeThreadId: THREAD_ID,
    [`threads:${PROJECT_ID}`]: [
      {
        id: THREAD_ID,
        title: 'Choose the database layer',
        status: 'idle',
        messages: [
          {
            id: 'prompt-postgres',
            role: 'user',
            content: 'Use PostgreSQL for the local prototype.',
            toolCalls: [],
            createdAt: now - 4_000,
          },
          {
            id: 'reply-postgres',
            role: 'assistant',
            content: 'I will wire the prototype to PostgreSQL and add a local migration.',
            toolCalls: [],
            createdAt: now - 3_000,
          },
          {
            id: 'prompt-correction',
            role: 'user',
            content: 'Actually, keep it self-contained and use SQLite.',
            toolCalls: [],
            createdAt: now - 2_000,
          },
          {
            id: 'reply-sqlite',
            role: 'assistant',
            content: 'Understood. I will use SQLite and keep setup to one command.',
            toolCalls: [],
            createdAt: now - 1_000,
          },
        ],
        usage: { inputTokens: 120, outputTokens: 96 },
        createdAt: now - 5_000,
        updatedAt: now - 1_000,
      },
    ],
  })
}

describe('edit thread history', function () {
  this.timeout(90_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedThread()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens the dot-menu Fork submenu, reconstructs the same thread, and survives reload', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await $$('.messages-list .msg')).length === 4, {
      timeout: 10_000,
      timeoutMsg: 'expected the seeded transcript',
    })

    const row = await $('.chat-row.selected')
    await row.$('.chat-menu-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await $('.context-menu-item*=Fork').click()
    const forkChoices = await $$('.context-menu-item').map((item) => item.getText())
    expect(forkChoices).toEqual(['Fork a copy', 'Edit thread history…'])
    await expect(row).toHaveAttribute('data-thread-id', THREAD_ID)
    await saveElementScreenshot('.context-menu', 'thread-history-dot-fork-menu.png')
    await $('.context-menu-item*=Edit thread history').click()

    const dialog = await $('#thread-history-editor')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(await $$('.history-editor-message')).toBeElementsArrayOfSize(4)
    await expect($('.history-editor-title')).toHaveText('Edit thread history')
    await saveElementScreenshot('#thread-history-editor', 'thread-history-editor-open.png')

    const textareas = await $$('.history-editor-message-input')
    await textareas[0]!.setValue('Use SQLite for the local prototype.')
    const includes = await $$('.history-editor-include')
    await includes[2]!.click()
    await $('.history-editor-actions .ui-btn-primary').click()

    await browser.waitUntil(async () => (await $$('.history-editor-message')).length === 3, {
      timeout: 10_000,
      timeoutMsg: 'expected the excluded correction to leave the reconstructed history',
    })
    await expect($('.history-editor-undo')).toBeDisplayed()
    await expect($('.history-editor-summary')).toHaveText('3 of 3 messages kept')
    await saveElementScreenshot('#thread-history-editor', 'thread-history-editor-applied.png')

    await $('.history-editor-close').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await expect(await $$('.messages-list .msg')).toBeElementsArrayOfSize(3)
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('Use SQLite for the local prototype.'),
    )
    await expect($('.messages-list')).not.toHaveText(
      expect.stringContaining('Actually, keep it self-contained'),
    )

    const threadIdAfterEdit = await $('.chat-row.selected').getAttribute('data-thread-id')
    expect(threadIdAfterEdit).toBe(THREAD_ID)

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await $$('.messages-list .msg')).length === 3, {
      timeout: 10_000,
      timeoutMsg: 'expected the reconstructed transcript after relaunch',
    })
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', THREAD_ID)
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('Use SQLite for the local prototype.'),
    )
  })
})
