import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-tool-diff-project'
const THREAD_ID = 'e2e-acp-tool-diff-thread'
const MESSAGE_ID = 'assistant-tool-diff'
const RELATIVE_PATH = 'src/renderer/views/input-bar.test.ts'

const sharedHead = ['    )', '  })', '']
const sharedTail = [
  '    const store = createStore({',
  "      workspaceRoot: '/repo',",
  "      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],",
  "      activeProjectId: 'project-1',",
  '    })',
]

describe('ACP tool diff', () => {
  before(async () => {
    const now = Date.now()
    const workspace = process.cwd()
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedE2eViewport()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspace, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Edit a test',
          status: 'idle',
          messages: [
            {
              id: 'user-tool-diff',
              role: 'user',
              content: 'Rename the draft attachment test.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: MESSAGE_ID,
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'tool-diff-edit',
                  name: 'Edit',
                  args: {},
                  status: 'done',
                  result: null,
                  content: [
                    {
                      type: 'diff',
                      path: join(workspace, RELATIVE_PATH),
                      oldText: [
                        ...sharedHead,
                        "  it('restores draft attachment chips when returning to the attaching thread', async () => {",
                        '    const first = thread()',
                        "    const second: Thread = { ...thread(), id: 'thread-2', title: 'Second' }",
                        ...sharedTail,
                      ].join('\n'),
                      newText: [
                        ...sharedHead,
                        "  it('queues quote-replies below the draft and sends them together', async () => {",
                        ...sharedTail,
                      ].join('\n'),
                    },
                  ],
                },
              ],
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a coloured unified diff under the workspace-relative path', async function () {
    this.timeout(90_000)
    const diff = $(`[data-message-id="${MESSAGE_ID}"] .acp-tool-diff`)
    await diff.waitForExist({ timeout: 45_000 })
    const path = diff.$('.acp-tool-diff-path')
    await expect(path).toHaveText(RELATIVE_PATH)
    await expect(path).toHaveAttribute('title', join(process.cwd(), RELATIVE_PATH))
    await expect(diff.$('.tool-stat-add')).toHaveText('+1')
    await expect(diff.$('.tool-stat-del')).toHaveText('-3')

    await diff.$('summary').click()
    await expect(diff).toHaveAttribute('open')
    const rows = await browser.execute((messageId) => {
      const lines = document.querySelectorAll<HTMLElement>(
        `[data-message-id="${messageId}"] .acp-diff-line`,
      )
      return Array.from(lines, (line) => ({
        kind: line.classList.item(1),
        background: getComputedStyle(line).backgroundColor,
        whiteSpace: getComputedStyle(line).whiteSpace,
      }))
    }, MESSAGE_ID)
    assert.deepEqual(
      rows.map((row) => row.kind),
      [
        'acp-diff-context',
        'acp-diff-context',
        'acp-diff-context',
        'acp-diff-del',
        'acp-diff-del',
        'acp-diff-del',
        'acp-diff-add',
        'acp-diff-context',
        'acp-diff-context',
        'acp-diff-context',
        'acp-diff-gap',
      ],
    )
    const background = (kind: string): string =>
      rows.find((row) => row.kind === kind)?.background ?? ''
    assert.notEqual(background('acp-diff-add'), background('acp-diff-del'))
    assert.notEqual(background('acp-diff-add'), background('acp-diff-context'))
    assert.ok(rows.every((row) => row.whiteSpace === 'pre'))

    await diff.scrollIntoView()
    await saveAppScreenshot('acp-tool-diff.png')
  })
})
