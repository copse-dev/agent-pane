import { $, $$, browser, expect } from '@wdio/globals'
import { INTERRUPTED_TURN_CONTINUATION } from '../../src/renderer/controller/turn-recovery.ts'
import { waitForAgentIdle } from './helpers.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'
import { acceptProtectedPrompt } from './helpers/composer.ts'

function seedInterruptedProviderTurn(workspaceRoot: string, externalTask = false): void {
  const projectId = 'e2e-provider-recovery-project'
  const threadId = 'e2e-provider-recovery-thread'
  const now = Date.now()
  const model = externalTask ? 'acp:claude-agent-acp#sonnet' : 'openrouter:x-ai/grok-4.5'
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Interrupted provider turn',
        status: 'idle',
        model,
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
            content: externalTask
              ? 'Review the release checks.'
              : 'Upload report.pdf, then remove the generated file.',
            toolCalls: [],
            createdAt: now + 2,
          },
          {
            id: 'msg-assistant-interrupted',
            role: 'assistant',
            content: externalTask
              ? 'The delegated check finished. Summarizing next.'
              : 'The report is uploaded. Cleaning up next.',
            model,
            turnOutcome: {
              status: 'failed',
              stopReason: 'error',
              source: 'provider',
              executor: externalTask ? 'acp' : 'local',
              provider: externalTask ? 'claude-agent-acp' : 'openrouter',
              model,
              lastEvent: 'tool',
              error: { code: 502, message: 'upstream disconnected' },
              endedAt: now + 3,
            },
            toolCalls: externalTask
              ? [
                  {
                    id: 'tc-external-task',
                    name: 'task',
                    title: 'Review release checks',
                    programmaticName: 'task',
                    kind: 'think',
                    args: { subagent_type: 'Explore', prompt: 'Review release checks' },
                    status: 'done',
                    result: 'Release checks passed.',
                  },
                ]
              : [
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
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    seedInterruptedProviderTurn(process.cwd())
    await browser.reloadSession()
    await $('[data-turn-recovery-card]').waitForDisplayed({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows saved partial progress and starts one explicit continuation', async () => {
    const failed = await $('[data-message-id="msg-assistant-interrupted"]').getElement()
    const card = await $('[data-turn-recovery-card]').getElement()
    const tool = await failed.$('[data-tool-id="tc-upload-report"]').getElement()
    await expect(failed).toHaveText('The report is uploaded. Cleaning up next.', {
      containing: true,
    })
    await expect(tool).toHaveAttribute('data-status', 'done')
    await expect(card).toHaveText('Retry this turn', { containing: true })
    await expect(card).toHaveText('An earlier turn completed with', { containing: true })
    await expect(await card.$$('.turn-recovery-button').getElements()).toBeElementsArrayOfSize(2)
    // A hatched status plate like Review and Comparison: no perimeter border and
    // a sentence-case title in the plate's severity hue (docs/ui-taste.md).
    const plate = await browser.execute(() => {
      const recovery = document.querySelector<HTMLElement>('[data-turn-recovery-card]')
      const title = recovery?.querySelector<HTMLElement>('.turn-recovery-title')
      const icon = recovery?.querySelector<HTMLElement>('.turn-recovery-icon')
      if (!recovery || !title || !icon) return { missing: true }
      const cardStyle = getComputedStyle(recovery)
      const titleStyle = getComputedStyle(title)
      return {
        missing: false,
        borderWidths: [
          cardStyle.borderTopWidth,
          cardStyle.borderRightWidth,
          cardStyle.borderBottomWidth,
          cardStyle.borderLeftWidth,
        ],
        titleTransform: titleStyle.textTransform,
        titleColor: titleStyle.color,
        severityColor: getComputedStyle(icon).color,
      }
    })
    expect(plate.missing).toBe(false)
    expect(plate.borderWidths).toEqual(['0px', '0px', '0px', '0px'])
    expect(plate.titleTransform).toBe('none')
    expect(plate.titleColor).toBe(plate.severityColor)

    await savePreparedElementScreenshot('.messages-list', 'provider-turn-recovery.png')

    await card.$('button*=Retry this turn').click()
    await acceptProtectedPrompt()
    await browser.waitUntil(
      async () => (await $$('.messages-list .msg-user').getElements()).length === 3,
      {
        timeout: 10_000,
        timeoutMsg: 'expected an explicit continuation user message',
      },
    )
    const prompts = await $$('.messages-list .msg-user').map((message) => message.getText())
    expect(prompts.at(-1)).toContain(INTERRUPTED_TURN_CONTINUATION)
    await expect($('[data-turn-recovery-card]')).not.toExist()
    await expect(failed).toHaveText('The report is uploaded. Cleaning up next.', {
      containing: true,
    })
    await expect(tool).toHaveAttribute('data-status', 'done')
    await waitForAgentIdle(30_000)
  })

  it('keeps the retry action after an external agent dispatches its own task', async () => {
    resetUserData()
    seedInterruptedProviderTurn(process.cwd(), true)
    await browser.reloadSession()
    const card = $('[data-turn-recovery-card]')
    await card.waitForDisplayed({ timeout: 30_000 })
    await expect(card).toHaveText('Retry this turn', { containing: true })
    await expect(await card.$$('.turn-recovery-button').getElements()).toBeElementsArrayOfSize(2)
    await expect($('[data-tool-id="tc-external-task"]')).toHaveAttribute('data-status', 'done')
    await expect($('[data-message-id="msg-assistant-interrupted"]')).toHaveText(
      'The delegated check finished. Summarizing next.',
      { containing: true },
    )
    await savePreparedElementScreenshot('.messages-list', 'external-agent-task-recovery.png')
  })
})
