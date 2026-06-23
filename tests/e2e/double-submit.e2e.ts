import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('double submit guard', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('only sends one message when submit is fired twice in quick succession', async function () {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-double-submit', { subagentsEnabled: false })
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    // Start a slow turn so the thread stays running, mirroring the laggy state
    // where the user manages to press Send/Enter more than once.
    const firstPrompt = 'first prompt [[mock:delay_ms 2000]]'
    await $('.prompt-input').setValue(firstPrompt)
    await $('.submit-btn').click()

    const becameRunning = await browser
      .waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
        timeout: 10_000,
      })
      .catch(() => false)
    await expect(becameRunning).toBe(true)

    // Fire two synchronous clicks back-to-back, exactly as a frozen renderer
    // would replay buffered input events once the main thread unblocks.
    await browser.execute(() => {
      const input = document.querySelector('.prompt-input') as HTMLTextAreaElement | null
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      if (input) input.value = 'queued follow up'
      btn?.click()
      btn?.click()
    })

    // The guard must collapse the double click into a single queued message.
    await expect($('.footer-queue')).toHaveText('1 queued', { wait: 5_000 })
    const queuedBadges = await $$('.message-queued-badge')
    await expect(queuedBadges).toHaveLength(1)

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'double-submit-single-queued.png'))

    await waitForAgentIdle(60_000)

    // After draining, the thread holds exactly the two distinct user messages —
    // not three (which is what a duplicate send would have produced).
    const userMessages = await $$('.msg-user .message-text')
    await expect(userMessages).toHaveLength(2)
    await expect(userMessages[0]).toHaveText(firstPrompt)
    await expect(userMessages[1]).toHaveText('queued follow up')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'double-submit-drained.png'))
  })
})
