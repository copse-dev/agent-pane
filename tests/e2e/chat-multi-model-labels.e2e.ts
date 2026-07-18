import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMultiModelChatFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval: when a thread's primary chat used more than one model, each
// assistant bubble shows a muted model label. Single-model threads stay clean
// (covered by the component test); this spec proves the multi-model layout.
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

  it('renders a model label on each assistant turn and captures a screenshot', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.message-model').waitForExist({ timeout: 30_000 })

    const labels = await browser.execute(() =>
      [...document.querySelectorAll('.msg-assistant .message-model')].map((n) => n.textContent),
    )
    expect(labels).toEqual(['claude-sonnet-4-6', 'qwen/qwen3.6-35b-a3b · local'])

    await saveAppScreenshot('chat-multi-model-labels.png')
  })
})
