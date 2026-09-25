import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedAcpPromptInterruptedFixture,
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

function seedAcpBudgetDeniedFixture(workspaceRoot: string): void {
  const projectId = 'e2e-acp-budget-denied-project'
  const threadId = 'e2e-acp-budget-denied-thread'
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'ACP continuation limit',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-acp-unfinished',
            role: 'user',
            content: 'Update the Selenium ADR with the spec findings.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-acp-tools',
            role: 'assistant',
            content:
              'Confirmed the key spec facts. Let me check the upstream issue before I write.',
            toolCalls: [
              {
                id: 'tc-acp-upstream-search',
                name: 'run_shell',
                args: { command: 'rg "WebDriver BiDi" docs/' },
                status: 'error',
                result:
                  'Interrupted before completion — no final output was received. This tool may have partially run or produced effects; inspect the current state before retrying it.',
                kind: 'search',
              },
            ],
            createdAt: now + 1,
          },
          {
            id: 'msg-assistant-acp-fallback',
            role: 'assistant',
            content:
              'Copse could not request a final response automatically because this turn reached its continuation limit. Send “continue” to resume.',
            turnOutcome: {
              status: 'failed',
              stopReason: 'error',
              rawStopReason: 'end_turn',
              source: 'host',
              executor: 'acp',
              provider: 'claude-agent-acp',
              model: 'acp:claude-agent-acp#opus[1m]',
              lastEvent: 'text',
              recovery: {
                reason: 'ended_after_tools',
                attempted: false,
                recovered: false,
              },
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

function seedAcpSettledOpenToolFixture(workspaceRoot: string): void {
  const projectId = 'e2e-acp-settled-open-tool-project'
  const threadId = 'e2e-acp-settled-open-tool-thread'
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'ACP settled open tool',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-acp-settled-open-tool',
            role: 'user',
            content: 'Tell me what landed this week.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-acp-settled-first-step',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tc-acp-settled-git-log',
                name: 'git_log',
                args: { max_count: 20 },
                status: 'done',
                result: 'Five matching commits',
              },
            ],
            createdAt: now + 1,
          },
          {
            id: 'msg-assistant-acp-settled-second-step',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tc-acp-settled-web-search',
                name: 'web_search',
                args: { query: 'latest merged pull requests' },
                status: 'error',
                result:
                  'Interrupted before completion — no final output was received. This tool may have partially run or produced effects; inspect the current state before retrying it.',
              },
            ],
            createdAt: now + 2,
          },
          {
            id: 'msg-assistant-acp-settled-answer',
            role: 'assistant',
            content: 'Five pull requests landed this week.',
            turnOutcome: {
              status: 'completed',
              stopReason: 'end_turn',
              rawStopReason: 'end_turn',
              source: 'provider',
              executor: 'acp',
              provider: 'codex-acp',
              model: 'acp:codex-acp#gpt-5.6-sol',
              lastEvent: 'text',
              endedAt: now + 3,
            },
            toolCalls: [],
            createdAt: now + 3,
          },
        ],
        usage: { inputTokens: 900, outputTokens: 150 },
        createdAt: now,
        updatedAt: now + 3,
      },
    ],
  })
}

describe('ACP interrupted by a new chat prompt', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpPromptInterruptedFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-user-acp-followup"]').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps the interrupted run folded and attributes the call when opened', async () => {
    const run = await $('.tool-card-rollup[data-rollup-key="run"]')
    await expect(run).toHaveAttribute('data-status', 'interrupted')
    await expect(run).not.toHaveAttribute('open')
    await expect(run.$(':scope > summary .tool-name')).toHaveText(
      'Used 4 tools · 2 steps · Interrupted',
    )
    await savePreparedElementScreenshot('.messages-list', 'acp-prompt-interruption-collapsed.png')

    await run.$(':scope > summary').click()
    await expect(run.$(':scope > .tool-rollup-body > .tool-interruption-note')).toHaveText(
      'Interrupted when you sent a new message.',
    )
    const step = await run.$('[data-step-message-id="msg-assistant-acp-interrupted-step"]')
    await expect(step).not.toHaveAttribute('open')
    await step.$(':scope > summary').click()
    const call = await step.$('[data-tool-id="tc-acp-interrupted-read"]')
    await expect(call).toHaveAttribute('data-status', 'interrupted')
    await expect(call).not.toHaveAttribute('open')
    await call.$(':scope > summary').click()
    await expect(call.$('.tool-interruption-note')).toHaveText(
      'Interrupted when you sent a new message.',
    )
    await expect(call).toHaveText('may have partially run or produced effects', {
      containing: true,
    })
    await savePreparedElementScreenshot('.messages-list', 'acp-prompt-interruption-expanded.png')
  })
})

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

  it('places the recovery fallback after the interrupted tool trace', async () => {
    const toolCard = await $('.tool-card[data-tool-id="tc-acp-upstream-search"]')
    const fallback = await $('[data-message-id="msg-assistant-acp-fallback"] .message-text')
    await expect(toolCard).toHaveAttribute('data-status', 'error')
    await expect(toolCard).toHaveAttribute('open')
    await expect(toolCard).toHaveText('may have partially run or produced effects', {
      containing: true,
    })
    await expect(toolCard).toHaveText('inspect the current state before retrying it', {
      containing: true,
    })
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

describe('ACP unfinished-turn recovery with exhausted continuation budget', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpBudgetDeniedFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-fallback"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('attributes the skipped recovery to the continuation limit and offers a next step', async () => {
    const fallback = await $('[data-message-id="msg-assistant-acp-fallback"] .message-text')
    await expect(fallback).toHaveText(
      'Copse could not request a final response automatically because this turn reached its continuation limit. Send “continue” to resume.',
    )
    await expect(fallback).not.toHaveText('The external agent stopped', { containing: true })

    await savePreparedElementScreenshot('.messages-list', 'acp-unfinished-turn-budget-denied.png')
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

describe('ACP successful turn with an unterminated tool call', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpSettledOpenToolFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-settled-answer"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('shows the completed rollup as failed without a running spinner', async () => {
    const anchor = await $('[data-message-id="msg-assistant-acp-settled-first-step"]')
    const rollup = await anchor.$('.tool-card-rollup')
    await expect(rollup).toHaveAttribute('data-status', 'error')
    await expect(rollup.$('summary.tool-card-header')).toHaveText(
      'Used 2 tools · 2 steps · 1 failed',
    )
    await expect(anchor.$('[data-status="running"]')).not.toExist()

    await expect(rollup).toHaveAttribute('open')
    const failedSearch = await anchor.$('[data-tool-id="tc-acp-settled-web-search"]')
    await expect(failedSearch).toHaveAttribute('data-status', 'error')
    await expect(
      $('[data-message-id="msg-assistant-acp-settled-answer"] .message-text'),
    ).toHaveText('Five pull requests landed this week.')

    await savePreparedElementScreenshot('.messages-list', 'acp-settled-open-tool.png')
  })
})
