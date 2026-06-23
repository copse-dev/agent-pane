import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('send-now stops the running turn and runs the queued message', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-send-now', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('aborts the active run and dispatches the queued prompt immediately', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    // Long mock delay keeps the first turn "running" long enough to queue + send-now.
    await $('.prompt-input').setValue('first slow prompt [[mock:delay_ms 5000]]')
    await $('.submit-btn').click()

    await browser.waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
      timeout: 10_000,
      timeoutMsg: 'expected Stop button while agent is running',
    })

    await browser.execute(() => {
      const input = document.querySelector('.prompt-input') as HTMLTextAreaElement | null
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      if (input) input.value = 'run me right now'
      btn?.click()
    })

    const queuedMsg = await $('.msg-queued')
    await queuedMsg.waitForExist({ timeout: 5_000 })
    await expect($('.footer-queue')).toHaveText('1 queued', { wait: 5_000 })
    await queuedMsg.$('.queued-send-now').click()

    await waitForAgentIdle(60_000)

    // The queued prompt is no longer pending and the footer queue is cleared.
    await expect($('.message-queued-badge')).not.toExist()
    const queueHidden = await browser.execute(() => {
      const el = document.querySelector('.footer-queue')
      return el instanceof HTMLElement ? el.hidden : true
    })
    await expect(queueHidden).toBe(true)

    const userMessages = await $$('.msg-user .message-text')
    await expect(userMessages[userMessages.length - 1]).toHaveText('run me right now')
    await saveAppScreenshot('queued-message-send-now.png')
  })
})
