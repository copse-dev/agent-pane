import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-acp-resource-paths-project'
const THREAD_ID = 'e2e-acp-resource-paths-thread'
const MESSAGE_ID = 'assistant-resource-paths'
const REPLY_ID = 'assistant-resource-reply'
const SCRATCH_PATH = 'site/screenshots/archive-attachment-chip.png'
const SCREENSHOT_PATH = 'tests/e2e/screenshots/archive-attachment-chip.png'

describe('ACP resource paths', () => {
  before(async () => {
    const now = Date.now()
    const workspace = process.cwd()
    const scratch = join(workspace, SCRATCH_PATH)
    const screenshot = join(workspace, SCREENSHOT_PATH)
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
          title: 'Generated files',
          status: 'idle',
          messages: [
            {
              id: 'user-resource-paths',
              role: 'user',
              content: 'Show the generated files.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: MESSAGE_ID,
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'resource-output',
                  name: 'show_files',
                  args: {},
                  status: 'done',
                  result: null,
                  content: [scratch, screenshot].map((uri) => ({
                    type: 'content',
                    content: { type: 'resource_link', uri, name: uri },
                  })),
                },
                {
                  id: 'resource-check',
                  name: 'check_files',
                  args: {},
                  status: 'done',
                  result: 'Files generated.',
                },
              ],
              createdAt: now + 1,
            },
            {
              id: REPLY_ID,
              role: 'assistant',
              content: `Here is [the generated screenshot](${scratch}).`,
              toolCalls: [],
              createdAt: now + 2,
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

  it('previews workspace images with relative captions and absolute hover paths', async function () {
    this.timeout(90_000)
    const scratch = join(process.cwd(), SCRATCH_PATH)
    const inlinePreview = $(`[data-message-id="${REPLY_ID}"] .acp-referenced-image`)
    await inlinePreview.waitForExist({ timeout: 45_000 })
    const content = await $(`[data-message-id="${MESSAGE_ID}"] > .tool-result-content`)
    const previews = await content.$$('.acp-resource-image')
    await expect(previews).toBeElementsArrayOfSize(2)
    await expect(content.$$('.acp-resource-link')).toBeElementsArrayOfSize(0)
    const captions = await browser.execute(
      (messageId) =>
        Array.from(
          document.querySelectorAll(
            `[data-message-id="${messageId}"] .acp-resource-image figcaption`,
          ),
          (caption) => caption.textContent,
        ),
      MESSAGE_ID,
    )
    assert.deepEqual(captions, [SCRATCH_PATH, SCREENSHOT_PATH])
    for (const [index, relativePath] of [SCRATCH_PATH, SCREENSHOT_PATH].entries()) {
      const preview = previews[index]
      assert.ok(preview)
      await expect(preview).toHaveAttribute('title', join(process.cwd(), relativePath))
      const image = await preview.$('img')
      assert.match((await image.getAttribute('src')) ?? '', /^data:image\/png;base64,/)
    }
    await expect(previews[0]).toHaveAttribute('hidden')
    await expect(previews[1]).not.toHaveAttribute('hidden')
    const replySentence = $(`[data-message-id="${REPLY_ID}"] .message-text > p`)
    await expect(replySentence).toHaveText('Here is the generated screenshot.')
    await expect(replySentence.$(`a[href="${scratch}"]`)).toHaveText('the generated screenshot')
    assert.equal(
      await browser.execute((replyId) => {
        const sentence = document.querySelector(`[data-message-id="${replyId}"] .message-text > p`)
        return sentence?.nextElementSibling?.classList.contains('acp-referenced-image') ?? false
      }, REPLY_ID),
      true,
      'the preview follows the complete sentence',
    )
    await expect(inlinePreview).toHaveAttribute('title', join(process.cwd(), SCRATCH_PATH))
    await expect(inlinePreview.$('.acp-referenced-image-path')).toHaveText(SCRATCH_PATH)
    await expect(inlinePreview.$('img')).toHaveAttribute('role', 'button')
    await inlinePreview.scrollIntoView()
    await saveAppScreenshot('acp-resource-paths.png')
  })
})
