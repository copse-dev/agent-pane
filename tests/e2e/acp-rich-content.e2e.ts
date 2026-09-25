import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-rich-content-project'
const THREAD_ID = 'e2e-acp-rich-content-thread'
const TOOL_MESSAGE_ID = 'assistant-rich-tools'
const ANSWER_MESSAGE_ID = 'assistant-rich-answer'
const MEDIA_SCREENSHOT = 'acp-rich-content.png'
const DETAILS_SCREENSHOT = 'acp-rich-content-details.png'

describe('ACP rich content', () => {
  before(async () => {
    const now = Date.now()
    const image = readFileSync(
      join(process.cwd(), 'tests/e2e/fixtures/inline-rollup-prototype.png'),
    ).toString('base64')
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'ACP rich content',
          status: 'idle',
          messages: [
            {
              id: 'user-rich-content',
              role: 'user',
              content: 'Inspect the generated assets and summarize the result.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: TOOL_MESSAGE_ID,
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'rich-output-tool',
                  name: 'inspect_outputs',
                  title: 'Inspected generated outputs',
                  programmaticName: 'inspect_outputs',
                  args: { path: 'src/renderer/views/conversation.ts' },
                  status: 'done',
                  result: null,
                  kind: 'search',
                  locations: [{ path: 'src/renderer/views/conversation.ts', line: 1210 }],
                  content: [
                    {
                      type: 'content',
                      content: {
                        type: 'image',
                        dataUrl: `data:image/png;base64,${image}`,
                        mimeType: 'image/png',
                        uri: 'tool-rollup-options.png',
                      },
                    },
                    {
                      type: 'content',
                      content: {
                        type: 'audio',
                        dataUrl: 'data:audio/ogg;base64,T2dnUw==',
                        mimeType: 'audio/ogg',
                      },
                    },
                    {
                      type: 'content',
                      content: {
                        type: 'resource_link',
                        uri: 'https://example.com/report',
                        name: 'report',
                        title: 'Generated report',
                        description: 'Open the complete inspection report',
                        mimeType: 'text/html',
                        size: 2048,
                      },
                    },
                    {
                      type: 'content',
                      content: {
                        type: 'resource',
                        uri: 'file:///inspection-notes.txt',
                        mimeType: 'text/plain',
                        text: 'The generated output passed the visual inspection.',
                      },
                    },
                    {
                      type: 'diff',
                      path: 'src/renderer/views/conversation.ts',
                      oldText: 'render images only',
                      newText: 'render every ACP content block',
                    },
                    { type: 'terminal', terminalId: 'terminal-inspection-1' },
                  ],
                },
                {
                  id: 'verify-output-tool',
                  name: 'read_file',
                  args: { path: 'docs/acp-v1-content-support.md' },
                  status: 'done',
                  result: 'Support matrix verified.',
                },
              ],
              createdAt: now + 1,
            },
            {
              id: ANSWER_MESSAGE_ID,
              role: 'assistant',
              content: 'The image, audio, linked report, diff, resource, and terminal are ready.',
              contentBlocks: [
                {
                  type: 'resource_link',
                  uri: 'https://example.com/report',
                  name: 'report',
                  title: 'Final report',
                  description: 'Review the persisted resource after reload',
                },
              ],
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

  it('renders persisted ACP media and resources outside a collapsed rollup', async () => {
    const rollup = $(`[data-message-id="${TOOL_MESSAGE_ID}"] > .tool-card-rollup`)
    await rollup.waitForDisplayed({ timeout: 30_000 })
    assert.equal(await rollup.getAttribute('open'), null)
    await expect(rollup.$('.tool-name')).toHaveText('Used 2 tools')

    const rich = $(`[data-message-id="${TOOL_MESSAGE_ID}"] > .tool-result-content`)
    await rich.waitForDisplayed({ timeout: 15_000 })
    await expect(rich.$$('.tool-result-image')).toBeElementsArrayOfSize(1)
    await expect(rich.$$('audio')).toBeElementsArrayOfSize(1)
    await expect(rich.$('.acp-resource-title')).toHaveText('Generated report')
    const diff = rich.$('.acp-tool-diff')
    await expect(diff.$('.acp-tool-diff-label')).toHaveText('Diff')
    await expect(diff.$('.acp-tool-diff-path')).toHaveText('src/renderer/views/conversation.ts')
    await expect(diff.$('.tool-stat-add')).toHaveText('+1')
    await expect(diff.$('.tool-stat-del')).toHaveText('-1')
    await expect(rich.$('.acp-terminal-reference code')).toHaveText('terminal-inspection-1')
    await expect($(`[data-message-id="${ANSWER_MESSAGE_ID}"] .acp-resource-title`)).toHaveText(
      'Final report',
    )
    await expect(
      $$(`[data-message-id="${TOOL_MESSAGE_ID}"] .tool-card .tool-result-content`),
    ).toBeElementsArrayOfSize(0)

    const layout = await browser.execute((messageId) => {
      const card = document.querySelector(`[data-message-id="${messageId}"] > .tool-card-rollup`)
      const content = document.querySelector(
        `[data-message-id="${messageId}"] > .tool-result-content`,
      )
      if (!(card instanceof HTMLElement) || !(content instanceof HTMLElement)) return null
      return {
        contentAfterCard:
          card.getBoundingClientRect().bottom <= content.getBoundingClientRect().top,
        fitsMessage: content.scrollWidth <= content.clientWidth,
      }
    }, TOOL_MESSAGE_ID)
    assert.deepEqual(layout, { contentAfterCard: true, fitsMessage: true })

    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    await saveAppScreenshot(MEDIA_SCREENSHOT)

    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = list.scrollHeight
    })
    await browser.pause(100)
    await saveAppScreenshot(DETAILS_SCREENSHOT)
  })
})
