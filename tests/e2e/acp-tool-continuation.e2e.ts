import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('ACP tool continuation outcomes', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    const now = Date.now()
    const projectId = 'e2e-acp-continuation'
    const threadId = 'e2e-acp-continuation-thread'
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Approval and recovered tool outcomes',
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0 },
          messages: [
            {
              id: 'user-continuation',
              role: 'user',
              content: 'Create the draft and report the result.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'assistant-continuation',
              role: 'assistant',
              content: 'The completed action returned a result after its original caller detached.',
              toolCalls: [
                {
                  id: 'cancelled-tool',
                  name: 'gh_pr_create',
                  args: { title: 'Draft fix' },
                  status: 'error',
                  result: 'Tool call "gh_pr_create" was cancelled before execution.',
                },
                {
                  id: 'denied-tool',
                  name: 'gh_pr_create',
                  args: { title: 'Draft fix' },
                  status: 'error',
                  result: 'Permission denied for the gh_pr_create tool call.',
                },
                {
                  id: 'recovered-tool',
                  name: 'gh_pr_create',
                  args: { title: 'Draft fix' },
                  status: 'done',
                  result: 'Created draft: https://github.com/example/repo/pull/123',
                },
              ],
              createdAt: now + 1,
            },
          ],
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps cancellation and denial distinct and displays the recovered output', async () => {
    await $('.messages-list').waitForExist({ timeout: 15_000 })
    for (const rollup of await $$('.tool-card-rollup')) {
      if (!(await rollup.getAttribute('open'))) await rollup.$('summary.tool-card-header').click()
    }
    for (const [id, expected] of [
      ['cancelled-tool', 'Tool call "gh_pr_create" was cancelled before execution.'],
      ['denied-tool', 'Permission denied for the gh_pr_create tool call.'],
      ['recovered-tool', 'Created draft: https://github.com/example/repo/pull/123'],
    ] as const) {
      const card = $(`[data-tool-id="${id}"]`)
      await card.waitForExist({ timeout: 5_000 })
      if (!(await card.getAttribute('open'))) await card.$('summary').click()
      await expect(card).toHaveText(expect.stringContaining(expected))
    }
    await saveAppScreenshot('acp-tool-continuation.png')
  })
})
