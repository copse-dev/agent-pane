import { wrapExternalContent } from '../../packages/agent/src/external-content.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStableWorkspace, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('native workflow read evidence', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    resetUserData()
    const timestamp = Date.UTC(2026, 10, 6, 12)
    const projectId = 'dated-history-project'
    const threadId = 'dated-history-thread'
    writeSeedConfig({
      projects: [{ id: projectId, name: 'workspace', path: seedStableWorkspace() }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'History since last night',
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: timestamp,
          updatedAt: timestamp,
          messages: [
            {
              id: 'dated-history-answer',
              role: 'assistant',
              createdAt: timestamp,
              content: 'The commit timestamps distinguish last night’s changes from today’s.',
              toolCalls: [
                {
                  id: 'dated-history',
                  name: 'git_log',
                  status: 'done',
                  args: { ref: 'main', max_count: 2 },
                  result: `History at main (${'a'.repeat(40)}):\nLocal checkout history; this does not establish the current remote tip. Compare this SHA with get_ci_status(branch) before combining history and CI evidence.\naaaaaaa 2026-11-06T10:14:09Z Fix current-day behavior\nbbbbbbb 2026-11-05T22:30:33+00:00 Fix last-night behavior`,
                },
              ],
            },
            {
              id: 'conversation-answer',
              role: 'assistant',
              createdAt: timestamp + 1,
              content:
                'The latest project’s conversation has three remaining items; older pages are available.',
              toolCalls: [
                {
                  id: 'conversation-page',
                  name: 'read_thread',
                  status: 'done',
                  args: { project_id: 'latest-project', thread_id: 'draft', limit: 1, offset: 0 },
                  result: wrapExternalContent(
                    'read_thread',
                    JSON.stringify(
                      {
                        title: 'Dissertation draft',
                        projectName: 'Latest project',
                        status: 'idle',
                        messages: [
                          {
                            content:
                              'Remaining: dataset manifest, server-error archive, Monday outline. Keep agents frozen.',
                            turnOutcome: { status: 'completed', stopReason: 'end_turn' },
                            role: 'assistant',
                            createdAt: timestamp,
                            id: 'draft-answer',
                            contentTruncated: false,
                            unavailable: false,
                            contentPath:
                              '/thread-store/latest-project/draft/messages/draft-answer.md',
                            toolCalls: [],
                            toolCallCount: 0,
                          },
                        ],
                        updatedAt: timestamp,
                        projectId: 'latest-project',
                        threadId: 'draft',
                        totalMessages: 21,
                        offset: 0,
                        nextOffset: 1,
                      },
                      null,
                      2,
                    ),
                  ),
                },
              ],
            },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps commit identifiers, ISO timestamps and subjects readable together', async () => {
    const selector = '.tool-card[data-tool-id="dated-history"]'
    const card = $(selector)
    await card.waitForExist({ timeout: 30_000 })
    await card.scrollIntoView()
    if ((await card.getAttribute('open')) === null) await card.$('summary.tool-card-header').click()
    const result = card.$('.tool-result')
    await expect(result).toBeDisplayed()
    await expect(result).toHaveText(expect.stringContaining('History at main'))
    await expect(result).toHaveText(
      expect.stringContaining('does not establish the current remote tip'),
    )
    await expect(result).toHaveText(
      expect.stringContaining('aaaaaaa 2026-11-06T10:14:09Z Fix current-day behavior'),
    )
    await expect(result).toHaveText(
      expect.stringContaining('bbbbbbb 2026-11-05T22:30:33+00:00 Fix last-night behavior'),
    )
    await saveElementScreenshot(selector, 'dated-git-history-evidence.png')
  })

  it('shows readable conversation text, project provenance and older-page evidence', async () => {
    const selector = '.tool-card[data-tool-id="conversation-page"]'
    const card = $(selector)
    await card.waitForExist({ timeout: 30_000 })
    await expect(card.$('.tool-name')).toHaveText('Read conversation')
    await card.scrollIntoView()
    if ((await card.getAttribute('open')) === null) await card.$('summary.tool-card-header').click()
    const result = card.$('.tool-result')
    await expect(result).toBeDisplayed()
    await expect(result).toHaveText(expect.stringContaining('Dissertation draft'))
    await expect(result).toHaveText(expect.stringContaining('Latest project'))
    await expect(result).toHaveText(expect.stringContaining('Keep agents frozen.'))
    await expect(result).toHaveText(expect.stringContaining('"nextOffset": 1'))
    await expect(result).toHaveText(expect.stringContaining('"status": "completed"'))
    await saveElementScreenshot(selector, 'conversation-page-evidence.png')
  })
})
