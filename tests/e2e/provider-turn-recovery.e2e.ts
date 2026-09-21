import { $, $$, browser, expect } from '@wdio/globals'
import { INTERRUPTED_TURN_CONTINUATION } from '../../src/renderer/controller/turn-recovery.ts'
import { waitForAgentIdle } from './helpers.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

function seedInterruptedProviderTurn(workspaceRoot: string): void {
  const projectId = 'e2e-provider-recovery-project'
  const threadId = 'e2e-provider-recovery-thread'
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Interrupted provider turn',
        status: 'idle',
        model: 'openrouter:x-ai/grok-4.5',
        messages: [
          {
            id: 'msg-user-earlier',
            role: 'user',
            content: 'Summarize the release checks.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-earlier',
            role: 'assistant',
            content: 'All release checks passed.',
            model: 'openai:gpt-5.4',
            turnOutcome: {
              status: 'completed',
              stopReason: 'end_turn',
              source: 'provider',
              executor: 'local',
              provider: 'openai',
              model: 'openai:gpt-5.4',
              lastEvent: 'text',
              endedAt: now + 1,
            },
            toolCalls: [],
            createdAt: now + 1,
          },
          {
            id: 'msg-user-interrupted',
            role: 'user',
            content: 'Upload report.pdf, then remove the generated file.',
            toolCalls: [],
            createdAt: now + 2,
          },
          {
            id: 'msg-assistant-interrupted',
            role: 'assistant',
            content: 'The report is uploaded. Cleaning up next.',
            model: 'openrouter:x-ai/grok-4.5',
            turnOutcome: {
              status: 'failed',
              stopReason: 'error',
              source: 'provider',
              executor: 'local',
              provider: 'openrouter',
              model: 'openrouter:x-ai/grok-4.5',
              lastEvent: 'tool',
              error: { code: 502, message: 'upstream disconnected' },
              endedAt: now + 3,
            },
            toolCalls: [
              {
                id: 'tc-upload-report',
                name: 'run_shell',
                args: { command: 'upload report.pdf' },
                status: 'done',
                result: 'uploaded report.pdf',
              },
            ],
            createdAt: now + 3,
          },
        ],
        usage: { inputTokens: 900, outputTokens: 140 },
        createdAt: now,
        updatedAt: now + 3,
      },
    ],
  })
}

describe('explicit provider turn recovery', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedInterruptedProviderTurn(process.cwd())
    await browser.reloadSession()
    await $('[data-turn-recovery-card]').waitForDisplayed({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows saved partial progress and starts one explicit continuation', async () => {
    const failed = await $('[data-message-id="msg-assistant-interrupted"]')
    const card = await $('[data-turn-recovery-card]')
    const tool = await failed.$('[data-tool-id="tc-upload-report"]')
    await expect(failed).toHaveText('The report is uploaded. Cleaning up next.', {
      containing: true,
    })
    await expect(tool).toHaveAttribute('data-status', 'done')
    await expect(card).toHaveText('Retry this turn', { containing: true })
    await expect(card).toHaveText('An earlier turn completed with', { containing: true })
    await expect(await card.$$('.turn-recovery-button')).toBeElementsArrayOfSize(2)

    await savePreparedElementScreenshot('.messages-list', 'provider-turn-recovery.png')

    await card.$('button*=Retry this turn').click()
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 3, {
      timeout: 10_000,
      timeoutMsg: 'expected an explicit continuation user message',
    })
    const prompts = await $$('.messages-list .msg-user').map((message) => message.getText())
    expect(prompts.at(-1)).toContain(INTERRUPTED_TURN_CONTINUATION)
    await expect($('[data-turn-recovery-card]')).not.toExist()
    await expect(failed).toHaveText('The report is uploaded. Cleaning up next.', {
      containing: true,
    })
    await expect(tool).toHaveAttribute('data-status', 'done')
    await waitForAgentIdle(30_000)
  })
})
