import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-checkup-open-files-project'
const THREAD_ID = 'e2e-checkup-open-files-thread'
const MESSAGE_ID = 'msg-assistant-checkup-open-files'

describe('checkup open-file fault', () => {
  before(async () => {
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Agent checkup',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-checkup-open-files',
              role: 'user',
              content: '/checkup',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: MESSAGE_ID,
              role: 'assistant',
              content: [
                'Copse checkup — 1 error(s), 0 warning(s), 3 healthy',
                '',
                'ERRORS',
                '✗ Agent file descriptors: claude-agent-acp ran out of open files (EMFILE, inherited open-file limit 256 soft / unlimited hard) and a replacement process did too, so it cannot read files, load settings, or start MCP servers.',
                "Fix: Raise the open-file limit for your desktop session (macOS: `launchctl limit maxfiles`; Linux: the login's `nofile` limit), then restart Copse.",
              ].join('\n'),
              toolCalls: [],
              createdAt: now + 1,
            },
          ],
          todos: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the descriptor diagnosis and actionable fix without clipping', async () => {
    const message = $(`[data-message-id="${MESSAGE_ID}"] .message-text`)
    await message.waitForDisplayed({ timeout: 30_000 })
    await expect(message).toHaveText('Agent file descriptors', { containing: true })
    await expect(message).toHaveText('launchctl limit maxfiles', { containing: true })
    const fits = await browser.execute((id) => {
      const node = document.querySelector(`[data-message-id="${id}"] .message-text`)
      return node instanceof HTMLElement && node.scrollWidth <= node.clientWidth
    }, MESSAGE_ID)
    expect(fits).toBe(true)
    await saveAppScreenshot('checkup-open-files-fault.png')
  })
})
