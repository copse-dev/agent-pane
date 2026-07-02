import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedQueuedMessageFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('queued message delete', function () {
  this.timeout(60_000)

  afterEach(() => {
    resetUserData()
  })

  it('removes a queued follow-up from the pinned panel', async function () {
    resetUserData()
    const { queuedText } = seedQueuedMessageFixture(process.cwd())
    await browser.reloadSession()

    await $('.conversation-queued .msg-queued').waitForExist({ timeout: 30_000 })
    await expect($('.conversation-queued .message-text')).toHaveText(queuedText)
    await expect($('.queued-delete')).toExist()

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-message-delete-before.png'))

    await $('.queued-delete').click()

    await browser.waitUntil(
      async () => (await $('.conversation-queued').getProperty('hidden')) === true,
      { timeout: 5_000 },
    )
    await expect($('.message-queued-badge')).not.toExist()
    await expect($('.footer-queue')).not.toExist()

    const userMessages = await $$('.messages-list .msg-user .message-text')
    await expect(userMessages).toHaveLength(1)
    await expect(userMessages[0]).toHaveText('Refactor the JSON parser.')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-message-delete-after.png'))
  })
})
