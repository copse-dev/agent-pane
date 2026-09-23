import { $, $$, browser, expect } from '@wdio/globals'
import type { Message, Thread } from '../../src/shared/types/index.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-content-filter'

function message(content: string, extra: Partial<Message> = {}): Message {
  return { id: `msg-${content}`, role: 'user', content, toolCalls: [], createdAt: 1, ...extra }
}

function thread(id: string, title: string, date: number, messages: Message[]): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: messages.map((m) => ({ ...m, createdAt: date })),
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: date,
    updatedAt: date,
  }
}

describe('sidebar user-request search', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [
        { id: PROJECT_ID, path: process.cwd(), name: 'workspace' },
        { id: 'other-workspace', path: `${process.cwd()}/packages`, name: 'Other workspace' },
      ],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: 'welcome',
      [`threads:${PROJECT_ID}`]: [
        thread('welcome', 'Current work', now, [message('Start here')]),
        thread('title-match', 'Needle title match', now - 1000, [message('A title-only match')]),
        thread('recent-request', 'Recent request', now - 2000, [
          message('Please find the needle in this request'),
        ]),
        thread('assistant-only', 'Assistant-only match', now - 3000, [
          message('Unrelated request'),
          message('needle', { role: 'assistant' }),
        ]),
        thread('automatic-only', 'Automatic continuation', now - 4000, [
          message('needle', { origin: { kind: 'machine', operationId: 'background-job' } }),
        ]),
        ...Array.from({ length: 10 }, (_, i) =>
          thread(`filler-${i}`, `Other work ${i}`, now - 5000 - i * 1000, [
            message('Unrelated work'),
          ]),
        ),
        thread('old-request', 'Older follow-up request', now - 30000, [
          message('Original request'),
          message('A later needle request'),
        ]),
      ],
      'threads:other-workspace': [
        thread('elsewhere', 'Other workspace request', now, [message('needle elsewhere')]),
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30000 })
  })

  after(() => {
    resetUserData()
  })

  it('finds persisted user requests beyond the first page in date order and opens a match', async () => {
    await expect($('.chat-row[data-thread-id="old-request"]')).not.toExist()
    await $('.projects-search-btn').click()
    const input = await $('.projects-search-input')
    await input.setValue('needle')
    await browser.waitUntil(
      async () =>
        (await $$('.chat-title').map((row) => row.getText())).join('|') ===
          'Needle title match|Recent request|Older follow-up request' &&
        !(await $('.thread-filter-status').isExisting()),
      {
        timeout: 15000,
        timeoutMsg: 'Expected title and user-request matches in newest-first order',
      },
    )
    await expect($('.chat-row[data-thread-id="assistant-only"]')).not.toExist()
    await expect($('.chat-row[data-thread-id="automatic-only"]')).not.toExist()
    await expect($('.chat-row[data-thread-id="elsewhere"]')).not.toExist()
    await saveElementScreenshot('#pane-projects', 'sidebar-thread-content-filter.png')

    await $('.chat-row[data-thread-id="old-request"]').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Older follow-up request')
    await expect($('.messages-list')).toHaveText(expect.stringContaining('A later needle request'))

    await input.setValue('no-such-request')
    await expect($('.chats-list .sidebar-empty')).toHaveText('No matching threads')
    await input.setValue('')
    await expect($('.chat-row[data-thread-id="welcome"]')).toExist()
  })

  it('clears the old search when switching workspaces and searches only the newly opened workspace', async () => {
    await $('.projects-search-input').setValue('needle')
    await $('.project-entry[data-project-id="other-workspace"] .project-row').click()
    await expect($('.projects-search-row')).not.toBeDisplayed()
    await expect($('.chat-row .chat-title')).toHaveText('Other workspace request')
    await $('.projects-search-btn').click()
    await $('.projects-search-input').setValue('needle')
    await expect($('.chat-row .chat-title')).toHaveText('Other workspace request')
    await browser.waitUntil(async () => !(await $('.thread-filter-status').isExisting()), {
      timeout: 15000,
    })
    await expect($$('.chat-row')).toBeElementsArrayOfSize(1)
    await browser.keys('Escape')
    await expect($('.projects-search-row')).not.toBeDisplayed()
  })
})
