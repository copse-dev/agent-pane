import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-resource-file-project'
const THREAD_ID = 'e2e-acp-resource-file-thread'
const FILE_PATH = 'docs/agent-development.md'

describe('ACP resource file links', () => {
  before(async () => {
    const now = Date.now()
    const workspace = process.cwd()
    const uri = join(workspace, FILE_PATH)
    resetUserData()
    seedE2eViewport()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspace, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Generated file',
          status: 'idle',
          messages: [
            {
              id: 'user-resource-file',
              role: 'user',
              content: 'Show the file.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'assistant-resource-file',
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'resource-file',
                  name: 'show_file',
                  args: {},
                  status: 'done',
                  result: null,
                  content: [
                    {
                      type: 'content',
                      content: { type: 'resource_link', uri, name: uri },
                    },
                  ],
                },
              ],
              createdAt: now + 1,
            },
            {
              id: 'assistant-resource-file-reply',
              role: 'assistant',
              content: `Open [the guide](${uri}).`,
              toolCalls: [],
              createdAt: now + 2,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 2,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens a cited resource in the file panel and hides its duplicate tool card', async function () {
    this.timeout(90_000)
    await $('[data-message-id="assistant-resource-file-reply"]').waitForExist({ timeout: 30_000 })
    const resource = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.tool-result-content .acp-resource-link')
      return {
        hidden: card?.hidden,
        label: card?.querySelector('.acp-resource-title')?.textContent,
        title: card?.title,
      }
    })
    assert.deepEqual(resource, {
      hidden: true,
      label: FILE_PATH,
      title: join(process.cwd(), FILE_PATH),
    })

    const link = await $('[data-message-id="assistant-resource-file-reply"] .message-text a')
    await expect(link).toHaveText('the guide')
    await expect(link).toHaveAttribute('data-workspace-resource-path', FILE_PATH)
    await link.click()

    const preview = await $('.markdown-file-preview')
    await preview.waitForDisplayed({ timeout: 15_000 })
    await expect(preview).toHaveText(expect.stringContaining('Agent development environment'))
    await saveAppScreenshot('acp-resource-file-reference.png')
  })
})
