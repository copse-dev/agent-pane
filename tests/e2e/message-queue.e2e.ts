import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('message queue while agent is running', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('queues follow-up prompts and drains them after the current turn', async function () {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-message-queue', { subagentsEnabled: false })
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const firstPrompt = 'first prompt [[mock:delay_ms 2000]]'
    await $('.prompt-input').setValue(firstPrompt)
    await $('.submit-btn').click()

    const becameRunning = await browser
      .waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
        timeout: 10_000,
      })
      .catch(() => false)
    if (!becameRunning) {
      const state = await browser.execute(() => {
        const input = document.querySelector('.prompt-input') as HTMLTextAreaElement | null
        const stop = document.querySelector('.stop-btn') as HTMLButtonElement | null
        const messages = Array.from(document.querySelectorAll('.msg')).map((node) => ({
          className: node.className,
          text: node.textContent,
        }))
        return {
          inputValue: input?.value,
          inputValidation: input?.validationMessage,
          stopHidden: stop?.hidden,
          messages,
        }
      })
      throw new Error(`expected Stop button while agent is running: ${JSON.stringify(state)}`)
    }

    await browser.execute(() => {
      const input = document.querySelector('.prompt-input') as HTMLTextAreaElement | null
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      if (input) input.value = 'queued follow up'
      btn?.click()
    })

    await expect($('.footer-queue')).toHaveText('1 queued', { wait: 5_000 })
    await expect($('.message-queued-badge')).toHaveText('QUEUED', { wait: 5_000 })
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'message-queue-queued.png'))

    await waitForAgentIdle(60_000)

    const queueHidden = await browser.execute(() => {
      const el = document.querySelector('.footer-queue')
      return el instanceof HTMLElement ? el.hidden : true
    })
    await expect(queueHidden).toBe(true)
    const userMessages = await $$('.msg-user .message-text')
    await expect(userMessages).toHaveLength(2)
    await expect(userMessages[0]).toHaveText(firstPrompt)
    await expect(userMessages[1]).toHaveText('queued follow up')
    await expect($('.message-queued-badge')).not.toExist()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'message-queue-drained.png'))
  })
})
