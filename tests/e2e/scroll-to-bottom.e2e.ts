import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedScrollStreamingFixture,
  seedScrollToBottomFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function scrollMessagesListToTop(): Promise<void> {
  await browser.execute(() => {
    const list = document.querySelector('.messages-list')
    if (!(list instanceof HTMLElement)) throw new Error('messages-list not found')
    list.scrollTop = 0
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    list.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

async function isScrollToBottomVisible(): Promise<boolean> {
  return browser.execute(() => {
    const btn = document.querySelector('.scroll-to-bottom')
    return btn instanceof HTMLElement && !btn.hidden
  })
}

describe('scroll to bottom', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  afterEach(() => {
    resetUserData()
  })

  it('shows the scroll-to-bottom button when scrolled up', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 15_000 })
    await scrollMessagesListToTop()

    await expect(await isScrollToBottomVisible()).toBe(true)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'scroll-to-bottom-scrolled-up.png'))

    await $('.scroll-to-bottom').click()
    await expect(await isScrollToBottomVisible()).toBe(false)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'scroll-to-bottom-at-bottom.png'))
  })

  it('keeps the view pinned when the user scrolls up during streaming', async () => {
    resetUserData()
    seedScrollStreamingFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    await $('.prompt-input').setValue('Please write a longer follow-up answer')
    await $('.submit-btn').click()

    await browser.waitUntil(
      async () => {
        const lastAssistant = await browser.execute(() => {
          const nodes = document.querySelectorAll('.msg-assistant .message-text')
          const last = nodes[nodes.length - 1]
          return last?.textContent ?? ''
        })
        return lastAssistant.includes('Mock response')
      },
      { timeout: 15_000, interval: 50 },
    )

    await scrollMessagesListToTop()

    // Stay scrolled up while tokens keep arriving.
    await browser.pause(400)

    await expect(await isScrollToBottomVisible()).toBe(true)
    const firstQuestionVisible = await browser.execute(() => {
      const firstUser = document.querySelector('.messages-list .msg-user')
      if (!(firstUser instanceof HTMLElement)) return false
      const list = document.querySelector('.messages-list')
      if (!(list instanceof HTMLElement)) return false
      const listRect = list.getBoundingClientRect()
      const msgRect = firstUser.getBoundingClientRect()
      return msgRect.top >= listRect.top - 4 && msgRect.top <= listRect.bottom
    })
    await expect(firstQuestionVisible).toBe(true)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'scroll-to-bottom-streaming-scrolled-up.png'))
  })
})
