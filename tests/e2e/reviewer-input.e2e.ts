import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-reviewer-input-project'
const THREAD_ID = 'e2e-reviewer-input-thread'

describe('saved reviewer input', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    const now = Date.now()
    const requests = [
      {
        id: 'request-tokens',
        question: 'Block on the token over-count?',
        context: 'The worktree change looks ready; the count includes older messages.',
        options: ['Fix first', 'Track a follow-up'],
      },
      {
        id: 'request-title',
        question: 'Wrap or truncate long titles?',
        context: 'The title clips in the narrow screenshot.',
        recommendation: 'Allow two lines, then an ellipsis.',
        options: ['Wrap to two lines', 'One-line ellipsis'],
      },
      {
        id: 'request-footer',
        question: 'Fix the footer spacing too?',
        context: 'The footer overlaps the content and leaves blank space.',
        options: ['Fix both', 'Overlap only'],
      },
    ]
    const messages = [
      {
        id: 'review-prompt',
        role: 'user',
        content: 'Review the open pull requests.',
        toolCalls: [],
        createdAt: now,
      },
      ...requests.map((request, index) => ({
        id: `origin-${request.id}`,
        role: 'assistant',
        content: `I found a review decision for PR #${String(3241 - index)}.`,
        toolCalls: [
          {
            id: request.id,
            name: index === 1 ? 'mcp__copse__request_review_input' : 'request_review_input',
            args: request,
            status: 'done',
            result: 'Saved for review.',
          },
        ],
        createdAt: now + index + 1,
      })),
      ...Array.from({ length: 45 }, (_, index) => ({
        id: `review-progress-${String(index)}`,
        role: 'assistant',
        content: `Review progress: checked pull request #${String(3100 + index)}.`,
        toolCalls: [],
        createdAt: now + 10 + index,
      })),
      {
        id: 'latest-review',
        role: 'assistant',
        content: 'Batch 1 is still running. I have saved three decisions for you.',
        toolCalls: [],
        createdAt: now + 100,
      },
    ]
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Review open pull requests',
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0 },
          messages,
          createdAt: now,
          updatedAt: now + 100,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('ships as a disabled experiment and can be enabled in Settings', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.waitForDisplayed()
    try {
      await dialog.$('button[data-section="customise"]').click()
      const row = dialog.$('.plugin-row[data-plugin-id="copse.reviewer-input"]')
      await row.waitForExist({ timeout: 15_000 })
      await row.scrollIntoView({ block: 'center' })
      await row.waitForDisplayed()
      await expect(row.$('.plugin-badge-experimental')).toHaveText('Experimental', {
        ignoreCase: true,
      })
      await expect(row).toHaveAttribute('data-enabled', 'false')
      await saveElementScreenshot(
        '.plugin-row[data-plugin-id="copse.reviewer-input"]',
        'reviewer-input-experimental.png',
      )
      await row.$('label.plugin-toggle').click()
      await expect(row).toHaveAttribute('data-enabled', 'true')
    } finally {
      await browser.keys('Escape')
      await dialog.waitForDisplayed({ reverse: true })
    }
  })

  it('lists compact questions and jumps to the exact saved tool call', async () => {
    const panel = $('.reviewer-input-panel')
    await panel.waitForDisplayed({ timeout: 30_000 })
    await expect($('.reviewer-input-toggle')).toHaveText('3 questions')
    await expect(panel.$$('.reviewer-input-item')).toBeElementsArrayOfSize(3)
    await expect(panel.$('.reviewer-input-context')).not.toExist()
    await saveAppScreenshot('reviewer-input-list.png')

    await panel.$('[data-reviewer-input-id="request-tokens"] .reviewer-input-origin').click()
    const origin = $('.reviewer-input-card[data-tool-id="request-tokens"]')
    await origin.waitForDisplayed({ timeout: 30_000 })
    await expect(origin).toHaveAttribute('open')
    await expect(origin).toHaveElementClass('reviewer-input-highlight')
    await saveAppScreenshot('reviewer-input-origin.png')
  })

  it('sends a saved answer and keeps it after reopening the task', async () => {
    const panel = $('.reviewer-input-panel')
    const row = panel.$('[data-reviewer-input-id="request-tokens"]')
    await row.$('.reviewer-input-question').click()
    await row.$('.reviewer-input-option').click()
    await row.$('.ui-btn-primary').click()
    await expect($('.reviewer-input-toggle')).toHaveText('2 questions')
    await panel.$('[data-reviewer-input-id="request-tokens"] .reviewer-input-question').click()
    await expect(
      panel.$('[data-reviewer-input-id="request-tokens"] .reviewer-input-answer'),
    ).toHaveText('Answered: Fix first')
    await saveAppScreenshot('reviewer-input-answered.png')

    await browser.reloadSession()
    await $('.reviewer-input-panel').waitForDisplayed({ timeout: 30_000 })
    await expect($('.reviewer-input-toggle')).toHaveText('2 questions')
    await $(
      '.reviewer-input-panel [data-reviewer-input-id="request-tokens"] .reviewer-input-question',
    ).click()
    await expect(
      $('.reviewer-input-panel [data-reviewer-input-id="request-tokens"] .reviewer-input-answer'),
    ).toHaveText('Answered: Fix first')
  })
})
