import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

describe('message queue while agent is running', () => {
  afterEach(() => {
    resetUserData()
  })

  it('queues follow-up prompts and drains them after the current turn', async function () {
    this.timeout(90_000)
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-message-queue', { subagentsEnabled: false })
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('.prompt-input').setValue('first prompt')
    await $('.submit-btn').click()

    await browser.waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
      timeout: 10_000,
      timeoutMsg: 'expected Stop button while agent is running',
    })

    await $('.prompt-input').setValue('queued follow up')
    await browser.execute(() => {
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      btn?.click()
    })

    await expect($('.footer-queue')).toHaveText('1 queued', { wait: 5_000 })
    await expect($('.message-queued-badge')).toHaveText('QUEUED', { wait: 5_000 })

    await waitForAgentIdle(60_000)

    const queueHidden = await browser.execute(() => {
      const el = document.querySelector('.footer-queue')
      return el instanceof HTMLElement ? el.hidden : true
    })
    await expect(queueHidden).toBe(true)
    const userMessages = await $$('.msg-user .message-text')
    await expect(userMessages).toHaveLength(2)
    await expect(userMessages[0]).toHaveText('first prompt')
    await expect(userMessages[1]).toHaveText('queued follow up')
    await expect($('.message-queued-badge')).not.toExist()
  })
})
