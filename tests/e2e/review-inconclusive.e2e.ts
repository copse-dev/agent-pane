import { $, browser, expect } from '@wdio/globals'
import { inconclusiveCheckReason } from '@copse/review/check-failure.ts'
import type { ThreadReviewReport } from '@shared/types'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('review with a checker abort', () => {
  before(async () => {
    resetUserData()
    const reason = inconclusiveCheckReason({
      kind: 'typecheck',
      target: 'head',
      argv: ['pnpm', 'run', 'typecheck'],
      status: 'failed',
      exitCode: 134,
      signal: null,
      durationMs: 10,
      output: '',
      outputTruncated: false,
    })
    const report: ThreadReviewReport = {
      status: 'done',
      startedAt: 1,
      models: { reviewer: 'reviewer', challenger: null },
      lenses: ['correctness'],
      baseRef: 'main',
      headCommit: 'abc1234',
      dirtyWorkingTree: false,
      execution: {
        backend: 'container',
        strength: 'container',
        executed: true,
        reason: 'Isolated execution',
      },
      checks: [{ kind: 'typecheck', verdict: 'undetermined' }],
      notChecked: [`typecheck: ${reason ?? 'unavailable'}`],
      findings: [],
      appendix: 0,
      refuted: 0,
      reviewers: [],
      verification: null,
      durationMs: 10,
    }
    writeSeedConfig({
      projects: [{ id: 'review-project', path: process.cwd(), name: 'workspace' }],
      activeProjectId: 'review-project',
      activeThreadId: 'review-thread',
      'threads:review-project': [
        {
          id: 'review-thread',
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

  it('shows the unavailable verification without inventing a finding or a clean verdict', async () => {
    const card = $('[data-review-report-card]')
    await card.waitForDisplayed({ timeout: 30_000 })
    await expect(card.$('.review-report-check')).toHaveText('typecheck ? undetermined')
    await expect(card.$('.review-report-ground-note')).toHaveText(
      expect.stringContaining('exit 134'),
    )
    await expect(card.$('.review-report-clean')).toHaveText(
      'No findings. Some checks could not be verified.',
    )
    await expect(card.$('.review-finding')).not.toExist()
    await saveAppScreenshot('review-checker-inconclusive.png')
  })
})
