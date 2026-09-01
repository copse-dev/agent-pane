import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedAcpUnfinishedTurnFixture,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

function seedAcpTrailingToolUpdateFixture(workspaceRoot: string): void {
  const projectId = 'e2e-acp-trailing-update-project'
  const threadId = 'e2e-acp-trailing-update-thread'
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'ACP trailing tool update',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-acp-trailing-update',
            role: 'user',
            content: 'Update the Selenium ADR with the spec findings.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-acp-trailing-tool',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tc-acp-trailing-search',
                name: 'run_shell',
                args: { command: 'rg "WebDriver BiDi" docs/' },
                status: 'done',
                result: 'docs/adr/selenium.md:WebDriver BiDi migration notes',
                kind: 'search',
              },
            ],
            createdAt: now + 1,
          },
          {
            id: 'msg-assistant-acp-final-answer',
            role: 'assistant',
            content: 'Updated the Selenium ADR and verified the diff.',
            turnOutcome: {
              status: 'completed',
              stopReason: 'end_turn',
              rawStopReason: 'end_turn',
              source: 'provider',
              executor: 'acp',
              provider: 'claude-agent-acp',
              model: 'acp:claude-agent-acp#opus[1m]',
              lastEvent: 'text',
              endedAt: now + 2,
            },
            toolCalls: [],
            createdAt: now + 2,
          },
        ],
        usage: { inputTokens: 800, outputTokens: 120 },
        createdAt: now,
        updatedAt: now + 2,
      },
    ],
  })
}

describe('ACP unfinished-turn recovery fallback', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpUnfinishedTurnFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-fallback"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('places the recovery fallback after the completed tool trace', async () => {
    const toolCard = await $('.tool-card[data-tool-id="tc-acp-upstream-search"]')
    const fallback = await $('[data-message-id="msg-assistant-acp-fallback"] .message-text')
    await expect(toolCard).toHaveAttribute('data-status', 'done')
    await expect(fallback).toHaveText(
      'The external agent stopped after using its tools without providing a final result. Send “continue” to resume.',
    )

    const positions = await browser.execute(() => {
      const tool = document.querySelector('.tool-card[data-tool-id="tc-acp-upstream-search"]')
      const answer = document.querySelector(
        '[data-message-id="msg-assistant-acp-fallback"] .message-text',
      )
      if (!tool || !answer) return null
      return {
        toolBottom: tool.getBoundingClientRect().bottom,
        fallbackTop: answer.getBoundingClientRect().top,
      }
    })
    expect(positions).not.toBeNull()
    expect(positions?.fallbackTop ?? 0).toBeGreaterThan(positions?.toolBottom ?? 0)

    await savePreparedElementScreenshot('.messages-list', 'acp-unfinished-turn-recovery.png')
  })
})

describe('ACP final answer followed by a trailing tool update', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpTrailingToolUpdateFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-final-answer"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('keeps the final answer after the completed tool trace without a fallback', async () => {
    const toolCard = await $('.tool-card[data-tool-id="tc-acp-trailing-search"]')
    const answer = await $('[data-message-id="msg-assistant-acp-final-answer"] .message-text')
    await expect(toolCard).toHaveAttribute('data-status', 'done')
    await expect(answer).toHaveText('Updated the Selenium ADR and verified the diff.')
    await expect($('[data-message-id="msg-assistant-acp-fallback"]')).not.toExist()

    const positions = await browser.execute(() => {
      const tool = document.querySelector('.tool-card[data-tool-id="tc-acp-trailing-search"]')
      const finalAnswer = document.querySelector(
        '[data-message-id="msg-assistant-acp-final-answer"] .message-text',
      )
      if (!tool || !finalAnswer) return null
      return {
        toolBottom: tool.getBoundingClientRect().bottom,
        answerTop: finalAnswer.getBoundingClientRect().top,
      }
    })
    expect(positions).not.toBeNull()
    expect(positions?.answerTop ?? 0).toBeGreaterThan(positions?.toolBottom ?? 0)

    await savePreparedElementScreenshot('.messages-list', 'acp-trailing-tool-update.png')
  })
})
