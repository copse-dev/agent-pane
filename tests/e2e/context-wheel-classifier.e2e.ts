import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import { join } from 'node:path'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  readSeededSettings,
  resetUserData,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-wheel-classifier-project'
const THREAD_ID = 'e2e-wheel-classifier-thread'
const RESULT = JSON.stringify({
  classifier: 'kev',
  model: 'kev-4b',
  elapsedMs: 41,
  type: 'boolean',
  probabilityTrue: 0.7,
})

/**
 * The context wheel counts the classifier tool: its schema under Tools once a
 * classifier is configured (and not before), and its results as part of the
 * conversation the next send carries. Nothing here is mocked in the product:
 * the popover is the main process's own estimate of the seeded thread.
 */
describe('context wheel counts the classifier tool', function () {
  this.timeout(120_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Triage a note',
          status: 'idle',
          messages: [
            {
              id: 'm-user',
              role: 'user',
              content: 'Is "app crashes on save" a bug or a question?',
              toolCalls: [],
              createdAt: Date.now(),
            },
            {
              id: 'm-assistant',
              role: 'assistant',
              content: 'The classifier rates it a bug (0.70).',
              toolCalls: [
                {
                  id: 'tc-classify',
                  name: 'ask_classifier',
                  args: {
                    classifier: 'kev',
                    state: { report: 'app crashes on save' },
                    type: 'boolean',
                    question: 'Is this a bug report?',
                  },
                  status: 'done',
                  result: RESULT,
                },
              ],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 900, outputTokens: 120 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  async function popoverRows(): Promise<Record<string, string>> {
    const wheel = $('.context-wheel')
    await wheel.waitForDisplayed({ timeout: 30_000 })
    // The estimate is requested after the thread loads; wait for the breakdown rows.
    await browser.waitUntil(
      async () => {
        await wheel.moveTo()
        return (await $$('.context-wheel-popover-row')).length > 0
      },
      { timeout: 30_000, timeoutMsg: 'the wheel never showed a context breakdown' },
    )
    return browser.execute(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.context-wheel-popover-row')].map((row) => [
          row.querySelector('.context-wheel-popover-name')?.textContent ?? '',
          row.querySelector('.context-wheel-popover-value')?.textContent ?? '',
        ]),
      ),
    )
  }

  /** "5.2k · 3%" -> 5200; "820 · 0%" -> 820. */
  function tokens(value: string | undefined): number {
    const match = /^([\d.]+)(k?)/.exec(value ?? '')
    assert.ok(match, `unreadable token figure: ${String(value)}`)
    return Number.parseFloat(match[1] ?? '0') * (match[2] === 'k' ? 1000 : 1)
  }

  it('adds the tool schema to Tools only once a classifier is configured, and counts its result', async () => {
    const without = await popoverRows()
    assert.ok(without['Conversation'], 'the thread, with its classifier result, is counted')
    const toolsWithout = tokens(without['Tools'])
    await $('.context-wheel').moveTo()
    await saveWheel('context-wheel-classifier-none.png')

    // Configure Kev (a saved connection) and restart: the tool is now offered to the model.
    const kev = CLASSIFIER_PRESETS.find((profile) => profile.id === 'kev')
    assert.ok(kev)
    writeSettings({
      ...readSeededSettings(),
      classifierProviders: { version: 1, profiles: [kev] },
    })
    await browser.reloadSession()
    const withClassifier = await popoverRows()
    const toolsWith = tokens(withClassifier['Tools'])
    assert.ok(
      toolsWith >= toolsWithout + 200,
      `Tools should grow by the classifier tool schemas: ${String(toolsWithout)} -> ${String(toolsWith)}`,
    )
    await expect($('.context-wheel-popover')).toBeDisplayed()
    await saveWheel('context-wheel-classifier-configured.png')

    const rollup = $('.tool-card-rollup')
    if (await rollup.isExisting()) {
      if (!(await rollup.getProperty('open'))) await rollup.$('summary.tool-card-header').click()
    }
    const card = $('.tool-card[data-tool-id="tc-classify"]')
    await card.waitForDisplayed()
    assert.match(await card.$('.tool-name').getText(), /classif/i)
    if (!(await card.getProperty('open'))) await card.$('summary.tool-card-header').click()
    await expect(card).toHaveText('probabilityTrue', { containing: true })
    await saveElementScreenshot(
      '.tool-card[data-tool-id="tc-classify"]',
      'classify-structured-card.png',
    )
  })

  async function saveWheel(name: string): Promise<void> {
    await $('.context-wheel').moveTo()
    await $('.context-wheel-popover').waitForDisplayed()
    // The whole window, not saveElementScreenshot: that parks the pointer first, which closes the hover.
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, name))
  }
})
