import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-checkup-window-crashes-project'
const THREAD_ID = 'e2e-checkup-window-crashes-thread'
const MESSAGE_ID = 'msg-assistant-checkup-window-crashes'

describe('checkup window crashes', () => {
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
          title: 'Window crash checkup',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-checkup-window-crashes',
              role: 'user',
              content: '/checkup',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: MESSAGE_ID,
              role: 'assistant',
              content: [
                'Copse checkup — 0 error(s), 1 warning(s), 3 healthy',
                '',
                'WARNINGS',
                // checkup-report.ts's renderer-crashes row, with the long unbroken
                // profile path a real home directory gives it.
                '! Window crashes: 3 window crashes in the last 7 days; the latest at 2026-11-26T09:41:07.512Z (reason oom, exit code 133, lastLargeIpc=threads:create estimated<=412MB ago=2140ms). Full record: /Users/a-rather-long-account-name/.copse/user-data/renderer-crashes.jsonl',
                '  Fix: If this keeps happening, attach that file to a bug report.',
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

  it('renders the window crash row and its record path without clipping', async () => {
    const message = $(`[data-message-id="${MESSAGE_ID}"] .message-text`)
    await message.waitForDisplayed({ timeout: 30_000 })
    await expect(message).toHaveText('Window crashes', { containing: true })
    await expect(message).toHaveText('renderer-crashes.jsonl', { containing: true })
    const fits = await browser.execute((id) => {
      const node = document.querySelector(`[data-message-id="${id}"] .message-text`)
      return node instanceof HTMLElement && node.scrollWidth <= node.clientWidth
    }, MESSAGE_ID)
    expect(fits).toBe(true)
    await saveAppScreenshot('checkup-window-crashes.png')
  })
})
