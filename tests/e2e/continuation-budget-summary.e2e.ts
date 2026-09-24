import { installMockScenario } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-continuation-summary-project'
const THREAD_ID = 'e2e-continuation-summary-thread'

describe('continuation budget exhaustion summary', () => {
  before(async () => {
    resetUserData()
    writeSettings({ model: 'claude-sonnet-4-6', subagentsEnabled: false })
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Parser task',
          status: 'idle',
          messages: [],
          todos: [
            {
              id: 'parser',
              content: 'Resolve the parser ambiguity before shipping',
              status: 'in_progress',
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
  })

  it('shows the exact open item and granted allowance reasons after the real loop stops', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(`.chat-row.selected[data-thread-id="${THREAD_ID}"]`).waitForDisplayed({
      timeout: 15_000,
    })
    await installMockScenario({
      title: 'Parser task',
      turns: [
        {
          user: 'Finish the parser task',
          responses: Array.from({ length: 20 }, (_, index) => ({
            text: ' ',
            ...(index < 19 ? { continueTurn: true } : {}),
          })),
        },
        ...Array.from({ length: 3 }, () => ({
          user: { includes: 'update_todos' },
          responses: [{ text: 'The plan item remains open.' }],
        })),
        ...Array.from({ length: 2 }, () => ({
          user: { includes: 'Before this turn can finish' },
          responses: [{ text: 'The parser ambiguity still needs a decision.' }],
        })),
      ],
    })
    await setComposerValue('Finish the parser task')
    await submitComposer()
    await $('.msg-user*=Finish the parser task').waitForExist({ timeout: 15_000 })
    await waitForAgentIdle(60_000)

    const summary = $(
      '//*[contains(@class,"msg-assistant")]//*[contains(@class,"message-text") and contains(.,"automatic continuation limit")]',
    )
    await summary.waitForDisplayed({ timeout: 15_000 })
    await expect(summary).toHaveText('automatic continuation limit of 5', { containing: true })
    await expect(summary).toHaveText('In progress: Resolve the parser ambiguity before shipping', {
      containing: true,
    })
    await expect(summary).toHaveText('todo closeout: 3', { containing: true })
    await expect(summary).toHaveText('pre-review plan reconciliation: 2', { containing: true })
    await expect(summary).toHaveText('send Continue to start a fresh turn', { containing: true })
    expect(await summary.getText()).not.toContain('review remediation')

    const tagged = await browser.execute(() => {
      const messages = Array.from(document.querySelectorAll('.msg-assistant .message-text'))
      const node = messages.find((candidate) =>
        candidate.textContent?.includes('automatic continuation limit'),
      )
      if (!(node instanceof HTMLElement)) return false
      node.dataset['e2eContinuationSummary'] = 'true'
      return true
    })
    expect(tagged).toBe(true)
    await saveElementScreenshot(
      '[data-e2e-continuation-summary="true"]',
      'continuation-budget-summary.png',
    )
  })
})
