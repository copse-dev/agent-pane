import { $, browser, expect } from '@wdio/globals'
import type { Thread } from '@shared/types'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-sidebar-live-sort'
const RECENT_THREAD_ID = 'recent-thread'
const OLDER_THREAD_ID = 'older-thread'
const RECENT_TITLE = 'Recently prompted work'
const OLDER_TITLE = 'Older thread to continue'

function thread(id: string, title: string, createdAt: number, lastPromptAt: number): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        content: `Earlier prompt in ${title}`,
        toolCalls: [],
        createdAt: lastPromptAt,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    lastPromptAt,
    createdAt,
    updatedAt: lastPromptAt,
  }
}

async function sidebarTitles(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.chats-list .chat-title')).map(
      (title) => title.textContent ?? '',
    ),
  )
}

describe('live sidebar thread ordering', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()

    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: RECENT_THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        thread(RECENT_THREAD_ID, RECENT_TITLE, now - 2_000, now - 1_000),
        thread(OLDER_THREAD_ID, OLDER_TITLE, now - 20_000, now - 10_000),
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('moves an older thread to the front as soon as the user prompts it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await sidebarTitles()).length === 2, {
      timeout: 20_000,
      timeoutMsg: 'expected seeded thread rows in the sidebar',
    })
    expect(await sidebarTitles()).toEqual([RECENT_TITLE, OLDER_TITLE])

    await $(`.chat-row*=${OLDER_TITLE}`).click()
    await expect($('.chat-row.selected .chat-title')).toHaveText(OLDER_TITLE)

    await setComposerValue('Continue this older thread')
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await sidebarTitles())[0] === OLDER_TITLE, {
      timeout: 10_000,
      timeoutMsg: 'prompted thread did not move to the front of the sidebar',
    })
    expect(await sidebarTitles()).toEqual([OLDER_TITLE, RECENT_TITLE])
    await waitForAgentIdle(20_000)
    await expect($('.chat-row.selected .chat-title')).toHaveText(OLDER_TITLE)

    await saveElementScreenshot('#pane-projects', 'thread-sidebar-live-prompt-order.png')
  })
})
