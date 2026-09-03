import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'
import { rememberCanvasArtefact } from '../../src/main/services/canvas-store.ts'

const PROJECT_ID = 'e2e-inline-visualization-project'
const THREAD_ID = 'e2e-inline-visualization-thread'
const REFERENCE =
  '\u{e200}visualize\u{e202}{"path":"/workspace/tool-rollup-approaches.html","mode":"wide","title":"Tool rollup approaches"}\u{e201}'

describe('ACP inline visualization reference', () => {
  before(async () => {
    const now = Date.now()
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Inline visualization',
          status: 'idle',
          messages: [
            {
              id: 'inline-vis-user',
              role: 'user',
              content: 'Show me the tool rollup options.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'inline-vis-assistant',
              role: 'assistant',
              content: `${REFERENCE}\nApproach C best balances compression with the conversation's chronology.`,
              toolCalls: [],
              canvasArtefacts: [{ title: 'Tool rollup approaches' }],
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    const preview = readFileSync(join(process.cwd(), 'tests/e2e/fixtures/git-changes-blue.png'))
    await rememberCanvasArtefact(PROJECT_ID, THREAD_ID, {
      title: 'Tool rollup approaches',
      mimeType: 'text/html',
      body: '<!doctype html><title>Tool rollup approaches</title><h1>Approach C</h1>',
      threadId: THREAD_ID,
      preview: `data:image/png;base64,${preview.toString('base64')}`,
    })
    await browser.reloadSession()
    await $('[data-message-id="inline-vis-assistant"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('hides the provider control frame and keeps the answer readable', async () => {
    const answer = $('[data-message-id="inline-vis-assistant"] .message-text')
    await expect(answer).toHaveText(
      "Approach C best balances compression with the conversation's chronology.",
    )
    expect(await $('.tool-card').isExisting()).toEqual(false)
    const card = $('.message-canvas-previews .canvas-preview-card')
    await card.waitForExist({ timeout: 20_000 })
    await expect(card.$('.canvas-preview-title')).toHaveText('Tool rollup approaches')
    expect(await card.$('.canvas-preview-image').getAttribute('src')).toContain(
      'data:image/png;base64,',
    )
    await expect(card.$('button')).toHaveText('Open')
    expect(await $('.messages-list').getText()).not.toContain('visualize')
    expect(await $('.messages-list').getText()).not.toContain(
      '/workspace/tool-rollup-approaches.html',
    )

    await savePreparedElementScreenshot('.messages-list', 'acp-inline-visualization-reference.png')

    await card.$('button').click()
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector('.browser-tabs-tab.is-active .browser-tabs-tab-label')
              ?.textContent ?? null,
        )) === 'Tool rollup approaches',
      { timeout: 20_000, timeoutMsg: 'expected Open to restore the saved canvas artefact' },
    )
  })
})
