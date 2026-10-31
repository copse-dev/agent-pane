import { createHash } from 'node:crypto'
import { $, $$, browser, expect } from '@wdio/globals'
import type { Thread } from '@shared/types'
import { threadActionRevision } from '@shared/threads/action-assessment.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-action-assessment'
const NOW = Date.now()

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    messages: [
      {
        id: id + '-user',
        role: 'user',
        content: 'Investigate the issue',
        toolCalls: [],
        createdAt: NOW - 1000,
      },
    ],
    lastPromptAt: NOW - 1000,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

describe('thread action sorting and gradual onboarding', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    const complete = thread('action-complete', 'Explanation delivered')
    const pending = thread('action-pending', 'Inspect validation results')
    const unknown = thread('action-unknown', 'Older investigation')
    const records = [
      { item: complete, status: 'complete', reason: 'The requested explanation was delivered.' },
      {
        item: pending,
        status: 'needs-action',
        reason: 'Validation finished, but its results were never inspected.',
      },
    ].map(({ item, status, reason }) => ({
      projectId: PROJECT_ID,
      threadId: item.id,
      candidate: createHash('sha256').update(threadActionRevision(item)).digest('hex'),
      assessment: {
        status,
        reason,
        evidence: [item.id + '-user'],
        revision: 'seeded-judge-evidence',
        assessedAt: NOW,
        source: 'judge',
      },
    }))
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: complete.id,
      settings: { sidebarThreadSort: 'action', onboardingCompleted: true },
      ['threads:' + PROJECT_ID]: [complete, unknown, pending],
      threadActionAssessmentsV1: { records, windowStartedAt: NOW, calls: 2, inputChars: 1000 },
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('sorts persisted signals and explains incomplete onboarding without resuming a thread', async () => {
    await $('.projects-sort-btn').waitForExist({ timeout: 30_000 })
    await $('.projects-sort-btn').click()
    await $('.context-menu').waitForDisplayed()
    const items = await $$('.context-menu-item').getElements()
    for (const item of items) {
      if ((await item.getText()) === 'Needs action') {
        await item.click()
        break
      }
    }
    await browser.waitUntil(
      async () => (await $('.thread-action-progress').getText()).includes('2 of 3 assessed'),
      { timeout: 30_000 },
    )
    const titles = await (
      await $$('.chats-list .chat-title').getElements()
    ).map((item) => item.getText())
    expect(titles).toEqual([
      'Inspect validation results',
      'Older investigation',
      'Explanation delivered',
    ])
    await expect($('[data-thread-id="action-pending"] .thread-action-status')).toHaveText(
      'Needs action',
    )
    await expect($('[data-thread-id="action-unknown"] .thread-action-status')).toHaveText(
      'Not assessed',
    )
    await expect($('[data-thread-id="action-complete"] .thread-action-status')).toHaveText(
      'Complete',
    )
    await expect($('.chat-row.is-running')).not.toExist()
    await saveElementScreenshot('#pane-projects', 'thread-action-assessment-onboarding.png')
  })
})
