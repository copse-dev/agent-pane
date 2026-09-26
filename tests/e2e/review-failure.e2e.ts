import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import type { ThreadReviewReport } from '../../src/shared/types/index.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { measureKitButtonRow } from './helpers/kit-buttons.ts'

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

    // Retry and × are compact kit buttons, not a bespoke `.card-*-button` stack
    // (#3065): one row height, the kit radius, and a square icon-only dismiss.
    const header = await measureKitButtonRow('[data-review-report-card] .review-report-header')
    assert.ok(header, 'review card header not found')
    assert.deepEqual(
      header.buttons.map((button) => button.label),
      ['Retry', 'Dismiss'],
    )
    for (const button of header.buttons) {
      for (const kit of ['ui-btn', 'ui-btn-secondary', 'ui-btn-compact']) {
        assert.ok(button.classes.includes(kit), `"${button.label}" must carry ${kit}`)
      }
      assert.equal(button.radius, header.kitRadius, `"${button.label}" must use the kit radius`)
    }
    const [retry, dismiss] = header.buttons
    assert.ok(retry && dismiss)
    assert.equal(retry.height, dismiss.height, 'Retry and × share the compact row height')
    assert.equal(dismiss.width, dismiss.height, 'the icon-only × is a square hit target')

    await saveAppScreenshot('review-provider-failure.png')
    await saveElementScreenshot('[data-review-report-card]', 'review-card-retry.png')
  })
})
