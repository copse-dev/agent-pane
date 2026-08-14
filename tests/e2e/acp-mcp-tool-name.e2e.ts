import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-mcp-name-project'
const THREAD_ID = 'e2e-acp-mcp-name-thread'

function seedAcpMcpToolNameFixture(): void {
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    expandedProjectId: PROJECT_ID,
    activeThreadId: THREAD_ID,
    [`threads:${PROJECT_ID}`]: [
      {
        id: THREAD_ID,
        title: 'ACP MCP tool name test',
        status: 'idle',
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [
          {
            id: 'msg-user-acp-mcp',
            role: 'user',
            content: 'Inspect the attached thread archive.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-acp-mcp',
            role: 'assistant',
            content: 'The archive was unpacked successfully.',
            toolCalls: [
              {
                id: 'tc-acp-mcp-name',
                name: 'mcp__copse__read_archive',
                args: { path: 'thread.zip' },
                status: 'done',
                result: 'Archive extracted.',
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
}

describe('ACP MCP tool name', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpMcpToolNameFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the recovered MCP tool name instead of Cursor’s generic placeholder', async () => {
    const card = $('.tool-card[data-tool-id="tc-acp-mcp-name"]')
    await card.waitForExist({ timeout: 30_000 })
    await expect(card.$('.tool-name')).toHaveText('Read Archive')
    await expect($('.messages-list')).not.toHaveText(expect.stringContaining('MCP: tool'))

    await saveAppScreenshot('acp-mcp-tool-name.png')
  })
})
