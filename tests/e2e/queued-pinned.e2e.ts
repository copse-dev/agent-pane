import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedScrollStreamingFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('queued chats stay pinned to the bottom', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('keeps queued messages pinned below a scrollable conversation', async function () {
    resetUserData()
    seedScrollStreamingFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 15_000 })

    // Kick off a slow turn so the agent stays running while we queue follow-ups.
    await $('.prompt-input').setValue('Please refactor this module [[mock:delay_ms 6000]]')
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
      timeout: 10_000,
    })

    // Queue two follow-ups while the agent is busy.
    for (const text of ['Also add unit tests for it.', 'Then update the README.']) {
      await browser.execute((value: string) => {
        const input = document.querySelector('.prompt-input') as HTMLTextAreaElement | null
        const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
        if (input) input.value = value
        btn?.click()
      }, text)
    }

    await $('.conversation-queued .msg-queued').waitForExist({ timeout: 5_000 })
    await browser.waitUntil(
      async () => (await $$('.conversation-queued .msg-queued')).length === 2,
      {
        timeout: 5_000,
      },
    )
    const queuedItems = await $$('.conversation-queued .msg-queued')
    await expect(queuedItems).toHaveLength(2)
    await expect($('.conversation-queued .message-queued-badge')).toHaveText('QUEUED')

    // Scroll the message list to the top — the pinned queue panel must remain visible.
    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    await browser.pause(300)

    const panelVisibleAfterScroll = await browser.execute(() => {
      const panel = document.querySelector('.conversation-queued')
      if (!(panel instanceof HTMLElement) || panel.hidden) return false
      const rect = panel.getBoundingClientRect()
      return rect.height > 0 && rect.bottom <= window.innerHeight + 1
    })
    await expect(panelVisibleAfterScroll).toBe(true)

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-pinned-scrolled-top.png'))
  })
})
