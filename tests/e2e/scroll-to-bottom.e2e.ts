import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedScrollStreamingFixture,
  seedScrollToBottomFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

const SCROLL_PIN_THRESHOLD_PX = 48

async function getScrollMetrics(): Promise<{
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
}> {
  return browser.execute(() => {
    const list = document.querySelector('.messages-list')
    if (!(list instanceof HTMLElement)) throw new Error('messages-list not found')
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
    return {
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      distanceFromBottom,
    }
  })
}

async function isNearBottom(threshold = SCROLL_PIN_THRESHOLD_PX): Promise<boolean> {
  const metrics = await getScrollMetrics()
  return metrics.distanceFromBottom <= threshold
}

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

async function waitForPromptReady(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const disabled = await $('.prompt-input').getProperty('disabled')
      return disabled !== true
    },
    { timeout: 15_000, interval: 100 },
  )
}

async function waitForAgentIdle(): Promise<void> {
  await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Send', {
    timeout: 15_000,
    interval: 100,
  })
  await waitForPromptReady()
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
    await expect(await isNearBottom()).toBe(false)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'scroll-to-bottom-scrolled-up.png'))
  })

  it('clicking scroll-to-bottom scrolls the view to the bottom', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 15_000 })
    await scrollMessagesListToTop()
    await expect(await isNearBottom()).toBe(false)

    await $('.scroll-to-bottom').click()

    await expect(await isNearBottom()).toBe(true)
    await expect(await isScrollToBottomVisible()).toBe(false)

    const lastMessageVisible = await browser.execute(() => {
      const messages = document.querySelectorAll('.messages-list .msg')
      const last = messages[messages.length - 1]
      if (!(last instanceof HTMLElement)) return false
      const list = document.querySelector('.messages-list')
      if (!(list instanceof HTMLElement)) return false
      const listRect = list.getBoundingClientRect()
      const msgRect = last.getBoundingClientRect()
      return msgRect.bottom <= listRect.bottom + 1 && msgRect.bottom >= listRect.top
    })
    await expect(lastMessageVisible).toBe(true)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'scroll-to-bottom-at-bottom.png'))
  })

  it('hides scroll-to-bottom while auto-scrolling during streaming', async () => {
    resetUserData()
    seedScrollStreamingFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await waitForPromptReady()
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

    await expect(await isNearBottom()).toBe(true)
    await expect(await isScrollToBottomVisible()).toBe(false)

    // More tokens arrive while still pinned to the bottom.
    await browser.pause(400)

    await expect(await isNearBottom()).toBe(true)
    await expect(await isScrollToBottomVisible()).toBe(false)

    await waitForAgentIdle()
  })

  it('keeps the view pinned when the user scrolls up during streaming', async () => {
    resetUserData()
    seedScrollStreamingFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await waitForPromptReady()

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
    await waitForAgentIdle()
  })
})
