import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import type { ThreadReviewReport } from '../../src/shared/types/index.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// Visual evidence for the persisted error state emitted when a reviewer fails.
// Service and controller unit tests cover failure propagation and startup recovery.
describe('review provider failure', () => {
  before(async () => {
    resetUserData()
    const error = 'gpt-5 (correctness): Provider authentication failed.'
    const report: ThreadReviewReport = {
      status: 'error',
      error,
      startedAt: 1,
      models: { reviewer: 'gpt-5', challenger: 'claude-opus-4-8' },
      lenses: ['correctness'],
      baseRef: 'main',
      headCommit: null,
      dirtyWorkingTree: false,
      execution: {
        backend: 'host-process',
        strength: 'none',
        executed: false,
        reason: 'No sandbox',
      },
      checks: [],
      notChecked: [],
      findings: [],
      appendix: 0,
      refuted: 0,
      reviewers: [
        {
          model: 'gpt-5',
          lens: 'correctness',
          outcome: 'failed',
          candidates: 0,
          summary: '',
          error,
        },
      ],
      verification: null,
      durationMs: 1000,
    }
    writeSeedConfig({
      projects: [{ id: 'review-failure-project', path: process.cwd(), name: 'workspace' }],
      activeProjectId: 'review-failure-project',
      activeThreadId: 'review-failure-thread',
      'threads:review-failure-project': [
        {
          id: 'review-failure-thread',
          title: 'Review changes',
          status: 'idle',
          messages: [
            {
              id: 'request-review',
              role: 'user',
              content: 'Review these changes.',
              toolCalls: [],
              createdAt: 1,
            },
          ],
          reviewReport: report,
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the error and retry controls instead of a clean verdict', async () => {
    const card = $('[data-review-report-card]')
    await card.waitForDisplayed({ timeout: 30_000 })
    const title = await browser.execute(
      () => document.querySelector('.review-report-title')?.textContent,
    )
    expect(title).toBe('Review failed')
    await expect(card.$('.review-report-error')).toHaveText(
      'gpt-5 (correctness): Provider authentication failed.',
    )
    await expect(card.$('.review-report-clean')).not.toExist()
    await expect(card.$('.card-retry-button')).toBeDisplayed()
    await expect(card.$('.card-dismiss-button')).toBeDisplayed()
    await saveAppScreenshot('review-provider-failure.png')
  })
})
