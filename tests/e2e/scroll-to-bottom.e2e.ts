import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedScrollStreamingFixture,
  seedScrollToBottomFixture,
} from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { itSkipInCi } from './helpers/ci-gate.ts'
import { setComposerValue } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCROLL_PIN_THRESHOLD_PX = 48
const STREAMING_PROMPT = 'Please write a detailed follow-up about the implementation plan.'
const STREAMING_RESPONSE = [
  'The implementation plan starts by mapping the current behavior and naming the smallest change that improves it without widening the API surface.',
  'Next, update the affected module and its focused tests together so the new behavior is documented by an executable example.',
  'Finally, run the relevant checks, review the diff for unintended changes, and record any follow-up work that needs a separate decision.',
].join('\n\n')

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

describe('scroll to bottom', () => {
  afterEach(() => {
    resetUserData()
  })

  it('shows the scroll-to-bottom button when scrolled up', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 30_000 })
    await scrollMessagesListToTop()

    await expect(await isScrollToBottomVisible()).toBe(true)
    await expect(await isNearBottom()).toBe(false)
    await saveAppScreenshot('scroll-to-bottom-scrolled-up.png')
  })

  it('clicking scroll-to-bottom scrolls the view to the bottom', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 30_000 })
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

    await saveAppScreenshot('scroll-to-bottom-at-bottom.png')
  })

  itSkipInCi('hides scroll-to-bottom while auto-scrolling during streaming', async () => {
    resetUserData()
    seedScrollStreamingFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await waitForPromptReady()
    const scenario = await installMockScenario({
      title: 'Implementation plan follow-up',
      turns: [
        {
          user: STREAMING_PROMPT,
          responses: [{ text: STREAMING_RESPONSE, chunkDelayMs: 8 }],
        },
      ],
    })
    await setComposerValue(STREAMING_PROMPT)
    await $('.submit-btn').click()

    await browser.waitUntil(
      async () => {
        const lastAssistant = await browser.execute(() => {
          const nodes = document.querySelectorAll('.msg-assistant .message-text')
          const last = nodes[nodes.length - 1]
          return last?.textContent ?? ''
        })
        return lastAssistant.includes('The implementation plan starts')
      },
      { timeout: 30_000, interval: 50 },
    )

    await expect(await isNearBottom()).toBe(true)
    await expect(await isScrollToBottomVisible()).toBe(false)

    // More tokens arrive while still pinned to the bottom.
    await browser.pause(400)

    await expect(await isNearBottom()).toBe(true)
    await expect(await isScrollToBottomVisible()).toBe(false)

    await waitForAgentIdle()
    await scenario.assertComplete()
  })

  itSkipInCi('keeps the view pinned when the user scrolls up during streaming', async () => {
    resetUserData()
    seedScrollStreamingFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await waitForPromptReady()

    const scenario = await installMockScenario({
      title: 'Implementation plan follow-up',
      turns: [
        {
          user: STREAMING_PROMPT,
          responses: [{ text: STREAMING_RESPONSE, chunkDelayMs: 8 }],
        },
      ],
    })
    await setComposerValue(STREAMING_PROMPT)
    await $('.submit-btn').click()

    await browser.waitUntil(
      async () => {
        const lastAssistant = await browser.execute(() => {
          const nodes = document.querySelectorAll('.msg-assistant .message-text')
          const last = nodes[nodes.length - 1]
          return last?.textContent ?? ''
        })
        return lastAssistant.includes('The implementation plan starts')
      },
      { timeout: 30_000, interval: 50 },
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

    await saveAppScreenshot('scroll-to-bottom-streaming-scrolled-up.png')
    await waitForAgentIdle()
    await scenario.assertComplete()
  })
})
