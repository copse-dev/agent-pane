import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'
import { acpSessionHandoverNotice } from '../../src/main/services/acp/acp-session-reattach.ts'

/**
 * The note an ACP turn opens with when the agent had to restart and could not
 * carry its session over — here, a custom agent that can resume but not load,
 * after the thread moved into its worktree. The copy is the product's own, so
 * this renders exactly what a user would read. Fixed example paths keep the
 * screenshot the same on every machine.
 */
function seedAcpSessionHandoverFixture(workspaceRoot: string): void {
  const projectId = 'e2e-acp-handover-project'
  const threadId = 'e2e-acp-handover-thread'
  const now = Date.now()
  const notice = acpSessionHandoverNotice(
    {
      reason: 'moved-without-load',
      fromCwd: '/Users/dev/shop',
      toCwd: '/Users/dev/shop/.copse/worktrees/fix-login-timeout',
    },
    'Local agent',
  )
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'ACP session handover',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-acp-handover-1',
            role: 'user',
            content: 'Find out why the login request times out.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-acp-handover-1',
            role: 'assistant',
            content: 'The session refresh retries forever when the token endpoint returns 503.',
            toolCalls: [],
            createdAt: now + 1,
          },
          {
            id: 'msg-user-acp-handover-2',
            role: 'user',
            content: 'Fix it.',
            toolCalls: [],
            createdAt: now + 2,
          },
          {
            id: 'msg-assistant-acp-handover-2',
            role: 'assistant',
            content: `${notice}I'll cap the refresh retries and add a test for the 503 path.`,
            toolCalls: [],
            createdAt: now + 3,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now + 3,
      },
    ],
  })
}

describe('ACP session handover notice', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    resetUserData()
    seedAcpSessionHandoverFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-handover-2"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('says what the restarted agent kept and lost, ahead of its reply', async () => {
    const message = await $('[data-message-id="msg-assistant-acp-handover-2"] .message-text')
    const note = await message.$('p em')
    await expect(note.$('strong')).toHaveText('Local agent lost its earlier session.')
    await expect(note).toHaveText(
      expect.stringContaining('your messages and its replies carry over'),
    )
    await expect(note).toHaveText(
      expect.stringContaining('tool calls and their output, the files it read, and its reasoning'),
    )
    await expect(note.$('code')).toHaveText(expect.stringContaining('fix-login-timeout'))

    const layout = await browser.execute(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-message-id="msg-assistant-acp-handover-2"] .message-text',
      )
      const paragraphs = root ? [...root.querySelectorAll('p')] : []
      const [notePara, reply] = paragraphs
      if (!root || !notePara || !reply) return { error: 'missing notice or reply paragraph' }
      const rootRect = root.getBoundingClientRect()
      return {
        noteFirst: notePara.getBoundingClientRect().bottom <= reply.getBoundingClientRect().top,
        replyText: reply.textContent,
        noteContained: notePara.getBoundingClientRect().right <= rootRect.right + 1,
      }
    })
    expect(layout).not.toHaveProperty('error')
    expect(layout.noteFirst).toBe(true)
    expect(layout.noteContained).toBe(true)
    expect(layout.replyText).toContain('cap the refresh retries')

    await savePreparedElementScreenshot(
      '[data-message-id="msg-assistant-acp-handover-2"]',
      'acp-session-handover.png',
    )
  })
})
