import { $, browser, expect } from '@wdio/globals'
import type { MockScriptStep } from '@copse/llm/mock-script.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-continuation-summary-project'
const THREAD_ID = 'e2e-continuation-summary-thread'

const SCRIPT = [
  // Empty responses spend the normal loop's 20-step allowance and reach its
  // bounded todo-finalize path without manufacturing a user-facing answer.
  ...Array.from({ length: 20 }, () => ({
    when: 'finish the parser task',
    text: ' ',
  })),
  ...Array.from({ length: 3 }, () => ({
    when: 'open todos|update_todos',
    text: 'The plan item remains open.',
  })),
  ...Array.from({ length: 2 }, () => ({
    when: 'Before this turn can finish',
    text: 'The parser ambiguity still needs a decision.',
  })),
] satisfies MockScriptStep[]

async function installMockScript(): Promise<void> {
  const status = await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (value: unknown) => Promise<{ steps: number }> }
      }
    ).__copseE2e
    if (!bridge?.setMockScript) throw new Error('__copseE2e.setMockScript unavailable')
    return bridge.setMockScript(script)
  }, SCRIPT)
  expect(status.steps).toBe(SCRIPT.length)
}

describe('continuation budget exhaustion summary', () => {
  before(async () => {
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
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
    await browser.execute(async () => {
      await (
        window as unknown as { __copseE2e?: { clearMockScript: () => Promise<void> } }
      ).__copseE2e?.clearMockScript?.()
    })
    resetUserData()
  })

  it('shows the exact open item and granted allowance reasons after the real loop stops', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await installMockScript()
    await setComposerValue('Finish the parser task')
    await $('.submit-btn').click()
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
