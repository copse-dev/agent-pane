import { mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedUnicodeChatFixture } from './helpers/seed-config.ts'

describe('Unicode chat fallback coverage', () => {
  let content: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({})
    resetUserData()
    ;({ content } = seedUnicodeChatFixture(process.cwd()))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders symbols, international scripts, and emoji in an assistant message', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const message = $('.messages-list .msg-assistant .message-text')
    await expect(message).toBeDisplayed()
    assert.equal(
      (await message.getText()).replaceAll('\n\n', '\n'),
      content.replaceAll('\n\n', '\n'),
    )

    await saveAppScreenshot('unicode-chat-fallbacks.png')
  })
})
