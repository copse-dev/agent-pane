import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedSingleModelChatFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval: a single-model thread still shows the muted model label on the
// assistant turn (best-value default makes the concrete route visible).
describe('primary-chat single-model label', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedSingleModelChatFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders a model label on a single-model thread and captures a screenshot', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.message-model').waitForExist({ timeout: 30_000 })

    const labels = await browser.execute(() =>
      [...document.querySelectorAll('.msg-assistant .message-model')].map((n) => n.textContent),
    )
    expect(labels).toEqual(['claude-sonnet-4-6'])

    await saveAppScreenshot('chat-single-model-label.png')
  })
})
