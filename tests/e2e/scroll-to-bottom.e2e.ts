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
import { AA_BODY_TEXT, fillContrast } from './helpers/fill-contrast.ts'
import { switchTheme } from './helpers/theme.ts'

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

  it('paints scroll-to-bottom as an accent fill with a readable glyph in both themes', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 30_000 })
    for (const theme of ['dark', 'light'] as const) {
      const current = await browser.execute(() => document.documentElement.dataset['theme'])
      if (current !== theme) await switchTheme(theme)
      await scrollMessagesListToTop()
      await expect(await isScrollToBottomVisible()).toBe(true)

      // White on an 80% --accent measured 2.91:1 in dark. The button is a fill
      // carrying the label tier now: --accent-fill + --text-on-accent, opaque,
      // floated on the shared --shadow-md rather than a one-off shadow.
      const paint = await browser.execute(() => {
        const btn = document.querySelector('.scroll-to-bottom')
        if (!(btn instanceof HTMLElement)) return null
        const probe = document.createElement('div')
        probe.style.cssText =
          'position:absolute;visibility:hidden;background:var(--accent-fill);color:var(--text-on-accent);box-shadow:var(--shadow-md)'
        document.body.append(probe)
        const expected = getComputedStyle(probe)
        const actual = getComputedStyle(btn)
        const result = {
          fill: actual.backgroundColor === expected.backgroundColor,
          label: actual.color === expected.color,
          shadow: actual.boxShadow === expected.boxShadow,
          opacity: actual.opacity,
        }
        probe.remove()
        return result
      })
      await expect(paint).toEqual({ fill: true, label: true, shadow: true, opacity: '1' })
      const rest = await fillContrast('.scroll-to-bottom')
      if (!rest) throw new Error('scroll-to-bottom not found')
      await expect(rest.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
      await saveAppScreenshot(`scroll-to-bottom-${theme}.png`)

      // The glyph is non-text, so hover holds it to the 3:1 non-text bar: light
      // darkens --accent-fill-hover, which is the kit's primary hover recipe.
      await $('.scroll-to-bottom').moveTo()
      await browser.pause(300)
      const hovered = await fillContrast('.scroll-to-bottom')
      if (!hovered) throw new Error('scroll-to-bottom not found')
      await expect(hovered.ratio).toBeGreaterThanOrEqual(3)
    }
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
