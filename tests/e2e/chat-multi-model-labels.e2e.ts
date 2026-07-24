import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMultiModelChatFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval: when a thread's primary chat used more than one model, a muted
// model label appears only at each model-segment boundary (first turn of a
// contiguous run). Same-model continuations stay unlabeled. Single-model
// threads stay clean (covered by the component test).
describe('primary-chat multi-model labels', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedMultiModelChatFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders model labels only at segment boundaries and captures a screenshot', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.message-model').waitForExist({ timeout: 30_000 })

    const labeled = await browser.execute(() =>
      [...document.querySelectorAll('.msg-assistant')].map((msgEl) => {
        const label = msgEl.querySelector('.message-model')
        return label?.textContent ?? null
      }),
    )
    // Fixture: sonnet → local → local (continuation). Only the two boundaries
    // get labels; the second local turn stays unlabeled.
    expect(labeled).toEqual(['Claude Sonnet 4.6', 'qwen/qwen3.6-35b-a3b · local', null])

    await saveAppScreenshot('chat-multi-model-labels.png')
  })
})
