import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-tool-image-project'
const THREAD_ID = 'e2e-acp-tool-image-thread'
const TOOL_MESSAGE_ID = 'assistant-tool-image'
const ANSWER_MESSAGE_ID = 'assistant-after-image'
const SCREENSHOT = 'acp-tool-result-image.png'

describe('ACP tool-result images', () => {
  before(async () => {
    const now = Date.now()
    const image = readFileSync(
      join(process.cwd(), 'tests/e2e/fixtures/inline-rollup-prototype.png'),
    )
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
          title: 'Generated image result',
          status: 'idle',
          messages: [
            {
              id: 'user-generate-image',
              role: 'user',
              content: 'Generate a visual for the tool rollup options.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: TOOL_MESSAGE_ID,
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'generated-image-tool',
                  name: 'Generate image',
                  args: { prompt: 'Tool rollup options' },
                  status: 'done',
                  result: 'Created the requested visual.',
                  resultFormat: 'markdown',
                  images: [
                    {
                      dataUrl: `data:image/png;base64,${image.toString('base64')}`,
                      name: 'tool-rollup-options.png',
                      kind: 'screenshot',
                    },
                  ],
                },
                {
                  id: 'inspect-image-tool',
                  name: 'Inspect image',
                  args: {},
                  status: 'done',
                  result: 'The image is ready.',
                  resultFormat: 'markdown',
                },
              ],
              createdAt: now + 1,
            },
            {
              id: ANSWER_MESSAGE_ID,
              role: 'assistant',
              content:
                'Here is the generated comparison. Approach C keeps the thread easiest to scan.',
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

  it('previews a persisted tool image inline outside the collapsed rollup and expands it', async () => {
    const rollup = $(`[data-message-id="${TOOL_MESSAGE_ID}"] > .tool-card-rollup`)
    await rollup.waitForDisplayed({ timeout: 30_000 })
    assert.equal(await rollup.getAttribute('open'), null)
    await expect(rollup.$('.tool-name')).toHaveText('Used 2 tools')

    const imageHost = $(`[data-message-id="${TOOL_MESSAGE_ID}"] > .tool-result-images`)
    await imageHost.waitForDisplayed({ timeout: 15_000 })
    await expect(
      $$(`[data-message-id="${TOOL_MESSAGE_ID}"] > .tool-result-images img`),
    ).toBeElementsArrayOfSize(1)
    await expect(rollup.$$('.tool-result-preview')).toBeElementsArrayOfSize(0)

    const preview = imageHost.$('.tool-result-preview')
    await expect(preview.$('.tool-result-preview-caption')).toHaveText('tool-rollup-options.png')
    const thumbnail = preview.$('.tool-result-preview-image.image-expandable')
    await expect(thumbnail).toHaveAttribute('alt', 'tool-rollup-options.png')
    await expect(thumbnail).toHaveAttribute('role', 'button')
    await expect(thumbnail).toHaveAttribute('aria-label', 'Expand tool-rollup-options.png')
    assert.match(await thumbnail.getAttribute('src'), /^data:image\/png;base64,/)
    const previewHeight = await browser.execute(
      (el) => el.getBoundingClientRect().height,
      thumbnail,
    )
    assert.ok(
      previewHeight > 240,
      `expected the inline preview to exceed thumbnail height, got ${String(previewHeight)}`,
    )
    await expect($(`[data-message-id="${ANSWER_MESSAGE_ID}"] .message-text`)).toHaveText(
      expect.stringContaining('Approach C'),
    )

    const order = await browser.execute(
      (toolMessageId, answerMessageId) => {
        const rollupEl = document.querySelector(
          `[data-message-id="${toolMessageId}"] > .tool-card-rollup`,
        )
        const imageEl = document.querySelector(
          `[data-message-id="${toolMessageId}"] > .tool-result-images`,
        )
        const answerEl = document.querySelector(
          `[data-message-id="${answerMessageId}"] .message-text`,
        )
        return {
          rollupBeforeImage:
            rollupEl instanceof HTMLElement &&
            imageEl instanceof HTMLElement &&
            rollupEl.getBoundingClientRect().bottom <= imageEl.getBoundingClientRect().top,
          imageBeforeAnswer:
            imageEl instanceof HTMLElement &&
            answerEl instanceof HTMLElement &&
            imageEl.getBoundingClientRect().bottom <= answerEl.getBoundingClientRect().top,
        }
      },
      TOOL_MESSAGE_ID,
      ANSWER_MESSAGE_ID,
    )
    assert.deepEqual(order, { rollupBeforeImage: true, imageBeforeAnswer: true })

    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    await saveAppScreenshot(SCREENSHOT)

    await thumbnail.click()
    const dialog = $('dialog.attachment-preview-dialog[open]')
    await dialog.waitForDisplayed({ timeout: 5_000 })
    await expect($('.attachment-preview-title')).toHaveText('tool-rollup-options.png')
    assert.match(await $('.image-expand-image').getAttribute('src'), /^data:image\/png;base64,/)
    await $('.attachment-preview-close').click()
  })
})
