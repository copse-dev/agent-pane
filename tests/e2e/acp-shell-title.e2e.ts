import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-shell-title-project'
const THREAD_ID = 'e2e-acp-shell-title-thread'
const LONG_TITLE = `cd /work && ${'echo hello; '.repeat(40)}`

// Replay the supported persisted ToolCall boundary used by ACP updates before
// rawInput arrives. The wire adapter is covered separately; no command runs.
describe('title-only ACP shell command', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    const now = 1_700_000_000_000
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'ACP command label',
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
          messages: [
            {
              id: 'shell-title-user',
              role: 'user',
              content: 'Check the shell command.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'shell-title-assistant',
              role: 'assistant',
              content: 'The command was interrupted.',
              createdAt: now + 1,
              toolCalls: [
                {
                  id: 'long-acp-shell',
                  name: 'Bash',
                  kind: 'execute',
                  title: LONG_TITLE,
                  args: {},
                  status: 'error',
                  result: 'Command interrupted before input details arrived.',
                },
              ],
            },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('compacts the long title and keeps the native tool card within the transcript', async () => {
    const card = $('[data-tool-id="long-acp-shell"]')
    await card.waitForDisplayed({ timeout: 30_000 })
    const label = card.$('.tool-name')
    const text = await label.getText()
    expect(text.length).toBeLessThanOrEqual(96)
    expect(text).toMatch(/^echo hello;/)
    expect(text).toMatch(/…$/)
    expect(text).not.toContain('cd /work')
    await expect(card).toHaveAttribute('data-status', 'error')
    await expect(card.$('.tool-result')).toHaveText(
      'Command interrupted before input details arrived.',
      { containing: true },
    )
    const geometry = await browser.execute(() => {
      const tool = document.querySelector('[data-tool-id="long-acp-shell"]')
      const name = tool?.querySelector('.tool-name')
      const transcript = document.querySelector('.messages-list')
      if (!tool || !name || !transcript) throw new Error('Missing shell title geometry')
      const cardRect = tool.getBoundingClientRect()
      const labelRect = name.getBoundingClientRect()
      const listRect = transcript.getBoundingClientRect()
      return { cardRight: cardRect.right, listRight: listRect.right, labelRight: labelRect.right }
    })
    expect(geometry.cardRight).toBeLessThanOrEqual(geometry.listRight + 1)
    expect(geometry.labelRight).toBeLessThanOrEqual(geometry.cardRight + 1)
    await savePreparedElementScreenshot(
      '[data-message-id="shell-title-assistant"]',
      'acp-shell-title.png',
    )
  })
})
