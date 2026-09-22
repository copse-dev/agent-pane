import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-startup-project'
const THREAD_ID = 'e2e-acp-startup-thread'

// The wire-level replay lives in acp-startup-tools.test.ts. This fixture pins
// the saved transcript's visible failure state, including the distinct server
// names and expandable original diagnostic, through the real Electron reader.
describe('Codex MCP startup failures', () => {
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
          title: 'MCP connection failures',
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
          messages: [
            {
              id: 'startup-user',
              role: 'user',
              content: 'Check the project documentation.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'startup-assistant',
              role: 'assistant',
              content: 'The documentation servers could not connect.',
              createdAt: now + 1,
              toolCalls: [
                {
                  id: 'startup-docs',
                  name: 'mcp__docs__startup',
                  args: {},
                  status: 'error',
                  result:
                    '[codex-acp forwarded startup error] MCP server `docs` failed to start: connection refused',
                  resultFormat: 'markdown',
                },
                {
                  id: 'startup-issue-tracker',
                  name: 'mcp__issue_tracker__startup',
                  args: {},
                  status: 'error',
                  result:
                    '[codex-acp forwarded startup error] MCP server `issue_tracker` startup was cancelled.',
                  resultFormat: 'markdown',
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

  it('shows distinct failed servers with their diagnostics and no activity spinner', async () => {
    const rollup = $('.tool-card-rollup')
    await rollup.waitForExist({ timeout: 30_000 })
    await expect(rollup).toHaveAttribute('data-status', 'error')
    await expect(rollup).toHaveAttribute('open')
    await expect(rollup.$('.tool-name')).toHaveText('Used 2 tools · 2 failed')

    const docs = $('[data-tool-id="startup-docs"]')
    const tracker = $('[data-tool-id="startup-issue-tracker"]')
    await expect(docs.$('.tool-name')).toHaveText('docs startup')
    await expect(tracker.$('.tool-name')).toHaveText('issue_tracker startup')
    await expect(docs).toHaveAttribute('data-status', 'error')
    await expect(tracker).toHaveAttribute('data-status', 'error')
    await expect(docs).toHaveAttribute('open')
    await expect(tracker).toHaveAttribute('open')
    await expect($$('.tool-card [data-icon="reasoning-activity"]')).toBeElementsArrayOfSize(0)

    await expect(docs.$('.tool-result')).toHaveText(expect.stringContaining('connection refused'))
    await expect(tracker.$('.tool-result')).toHaveText(
      expect.stringContaining('startup was cancelled'),
    )
    await expect(docs.$('.tool-result code')).toHaveText('docs')
    const failedLabelStyle = await browser.execute(() => {
      const name = document.querySelector<HTMLElement>('[data-tool-id="startup-docs"] .tool-name')
      if (!name) throw new Error('Expected the failed tool label')
      const probe = document.createElement('span')
      probe.style.color = 'var(--error)'
      document.body.append(probe)
      const expectedColor = getComputedStyle(probe).color
      probe.remove()
      const style = getComputedStyle(name)
      return { color: style.color, expectedColor, fontWeight: style.fontWeight }
    })
    expect(failedLabelStyle.color).toBe(failedLabelStyle.expectedColor)
    expect(failedLabelStyle.fontWeight).toBe('600')
    await $('[data-message-id="startup-user"]').moveTo()
    await savePreparedElementScreenshot(
      '[data-message-id="startup-assistant"]',
      'acp-startup-tools.png',
    )
  })
})
