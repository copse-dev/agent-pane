import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import type { ThreadReviewReport } from '@shared/types'

const projectId = 'e2e-review-anchor-project'
const threadId = 'e2e-review-anchor-thread'

function report(startedAt: number, note: string): ThreadReviewReport {
  return {
    status: 'done',
    startedAt,
    models: { reviewer: 'gpt-5', challenger: null },
    lenses: ['correctness'],
    baseRef: 'main',
    headCommit: 'abc1234',
    dirtyWorkingTree: false,
    execution: { backend: '', strength: 'none', executed: false, reason: 'unavailable' },
    checks: [],
    notChecked: [],
    findings: [],
    appendix: 0,
    refuted: 0,
    reviewers: [],
    verification: null,
    durationMs: 12,
    note,
  }
}

describe('Copse Reviewer reports stay with their turns', () => {
  before(async () => {
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Two reviews',
          status: 'idle',
          messages: [
            {
              id: 'user-first',
              role: 'user',
              content: 'Review the first change.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'assistant-first',
              role: 'assistant',
              content: 'The first change is ready.',
              toolCalls: [],
              createdAt: now + 1,
              reviewReport: report(now + 2, 'First review'),
            },
            {
              id: 'user-second',
              role: 'user',
              content: 'Please revise it.',
              toolCalls: [],
              createdAt: now + 3,
            },
            {
              id: 'assistant-second',
              role: 'assistant',
              content: 'The revision is ready.',
              toolCalls: [],
              createdAt: now + 4,
              reviewReport: report(now + 5, 'Second review'),
            },
            {
              id: 'user-later',
              role: 'user',
              content: 'One more request.',
              toolCalls: [],
              createdAt: now + 6,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 6,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('keeps both cards after their own assistant message, above later turns', async () => {
    await $('.messages-list [data-review-report-for="assistant-first"]').waitForExist({
      timeout: 30_000,
    })
    const order = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const children = [...(list?.children ?? [])]
      return {
        cards: list?.querySelectorAll('[data-review-report-card]').length ?? 0,
        firstMessage: children.findIndex(
          (child) => child.getAttribute('data-message-id') === 'assistant-first',
        ),
        firstReport: children.findIndex(
          (child) => child.getAttribute('data-review-report-for') === 'assistant-first',
        ),
        secondMessage: children.findIndex(
          (child) => child.getAttribute('data-message-id') === 'assistant-second',
        ),
        secondReport: children.findIndex(
          (child) => child.getAttribute('data-review-report-for') === 'assistant-second',
        ),
        laterMessage: children.findIndex(
          (child) => child.getAttribute('data-message-id') === 'user-later',
        ),
      }
    })
    expect(order.cards).toBe(2)
    expect(order.firstReport).toBe(order.firstMessage + 1)
    expect(order.secondReport).toBe(order.secondMessage + 1)
    expect(order.firstReport).toBeLessThan(order.secondMessage)
    expect(order.secondReport).toBeLessThan(order.laterMessage)
    await saveAppScreenshot('review-report-anchoring.png')
  })
})
