import { $, $$, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-device-hub-png'
const THREAD_ID = 'png-result-thread'
const SAVED =
  'Saved image/png (68 bytes, 1×1 px) from device disposable to artifacts/simulator.png.'
const ATTACHED =
  'Attached image/png (68 bytes, 1×1 px) of device disposable. No workspace image file was saved. Use output_path to save a PNG.'

// The native bytes/path contract is covered by device-hub-tool.test.ts. This
// fixture proves the saved-file distinction stays visible in the transcript.
describe('Device Hub PNG result reporting', () => {
  before(async () => {
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: seedStableWorkspace(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Save a simulator screenshot',
          status: 'idle',
          messages: [
            {
              id: 'png-request',
              role: 'user',
              content: 'Save a PNG and compare it with an attachment-only capture.',
              toolCalls: [],
              createdAt: now,
            },
            ...[SAVED, ATTACHED].map((result, index) => ({
              id: `png-result-${String(index)}`,
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: `png-tool-${String(index)}`,
                  name: 'device_hub',
                  args: {
                    action: 'screenshot',
                    device_id: 'disposable',
                    ...(index === 0 ? { output_path: 'artifacts/simulator.png' } : {}),
                  },
                  status: 'done',
                  result,
                },
              ],
              createdAt: now + index + 1,
            })),
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 2,
        },
      ],
    })
    writeSettings({ model: 'claude-sonnet-4-6', subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('distinguishes a saved PNG from an image attachment', async function () {
    this.timeout(60_000)
    await $('.tool-card-rollup').waitForExist({ timeout: 20_000 })
    for (const rollup of await $$('.tool-card-rollup, .tool-card-step, .tool-card-group')) {
      if (!(await rollup.getProperty('open'))) await rollup.$('summary.tool-card-header').click()
    }
    for (const [index, expected] of [SAVED, ATTACHED].entries()) {
      const card = $(`[data-tool-id="png-tool-${String(index)}"]`)
      await card.waitForDisplayed({ timeout: 30_000 })
      if (!(await card.getProperty('open'))) await card.$('summary.tool-card-header').click()
      await expect(card.$('.tool-result')).toHaveText(expected)
    }
    await expect($$('.tool-card.is-error')).toBeElementsArrayOfSize(0)
    await saveAppScreenshot('device-hub-png-results.png')
  })
})
