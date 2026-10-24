import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedScrollStreamingFixture,
  seedScrollToBottomFixture,
} from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { itSkipInCi } from './helpers/ci-gate.ts'
import { composerText, setComposerValue } from './helpers/composer.ts'
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

  it('jumps to the first prompt and returns to the saved reading position without losing a draft', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()
    await $('.messages-list .msg-user').waitForExist({ timeout: 30_000 })
    await $('.conversation-first-prompt').waitForDisplayed()
    await setComposerValue('Keep the existing keyboard shortcuts working.')
    // Save a position in the middle, rather than conflating return with latest.
    await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('.messages-list')
      if (!list) throw new Error('Missing transcript')
      list.scrollTop = (list.scrollHeight - list.clientHeight) / 2
      list.dispatchEvent(new Event('scroll'))
    })
    const before = await getScrollMetrics()
    await expect($('.scroll-to-bottom')).toHaveText('Back to latest')
    await saveAppScreenshot('first-prompt-desktop-resting.png')

    const first = $('.conversation-first-prompt')
    await first.moveTo()
    await expect($('.conversation-first-prompt-label')).toBeDisplayed()
    expect(await getScrollMetrics()).toEqual(before)
    await saveAppScreenshot('first-prompt-desktop-hover.png')
    await first.click()
    await expect($('.scroll-to-bottom')).toHaveText('Back to where you were')
    await expect(first).not.toBeDisplayed()
    const firstPromptVisible = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const prompt = list?.querySelector('.msg-user:not(.msg-machine-origin):not(.msg-hook-origin)')
      if (!list || !prompt) return false
      const viewport = list.getBoundingClientRect()
      const rect = prompt.getBoundingClientRect()
      return rect.top >= viewport.top - 1 && rect.top < viewport.bottom
    })
    expect(firstPromptVisible).toBe(true)
    expect(await composerText()).toBe('Keep the existing keyboard shortcuts working.')
    await saveAppScreenshot('first-prompt-desktop-jumped.png')

    await $('.scroll-to-bottom').click()
    expect(Math.abs((await getScrollMetrics()).scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
    await expect($('.scroll-to-bottom')).toHaveText('Back to latest')
    expect(await composerText()).toBe('Keep the existing keyboard shortcuts working.')
    await saveAppScreenshot('first-prompt-desktop-returned.png')
  })

  it('shows the scroll-to-bottom button when scrolled up', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 30_000 })
    await scrollMessagesListToTop()

    expect(await isScrollToBottomVisible()).toBe(true)
    expect(await isNearBottom()).toBe(false)
    await saveAppScreenshot('scroll-to-bottom-scrolled-up.png')
  })

  it('paints the return label with readable contrast in both themes', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 30_000 })
    for (const theme of ['dark', 'light'] as const) {
      const current = await browser.execute(() => document.documentElement.dataset['theme'])
      if (current !== theme) await switchTheme(theme)
      await scrollMessagesListToTop()
      expect(await isScrollToBottomVisible()).toBe(true)

      const layout = await browser.execute(() => {
        const button = document.querySelector('.scroll-to-bottom')
        const first = document.querySelector('.conversation-first-prompt')
        const list = document.querySelector('.messages-list')
        const composer = document.querySelector('#input-bar')
        if (!button || !first || !list || !composer) throw new Error('Missing chat controls')
        const rect = button.getBoundingClientRect()
        const listRect = list.getBoundingClientRect()
        const style = getComputedStyle(button)
        return {
          background: style.backgroundColor,
          shadow: style.boxShadow,
          belowTranscript: rect.top >= listRect.bottom,
          aboveComposer: rect.bottom <= composer.getBoundingClientRect().top,
          rightAligned: rect.right > listRect.left + listRect.width / 2,
          firstRight: getComputedStyle(first).right,
          opacity: style.opacity,
        }
      })
      expect(layout.background).toBe('rgba(0, 0, 0, 0)')
      expect(layout.shadow).toBe('none')
      expect(layout.belowTranscript).toBe(true)
      expect(layout.aboveComposer).toBe(true)
      expect(layout.rightAligned).toBe(true)
      expect(layout.firstRight).not.toBe('auto')
      expect(layout.opacity).toBe('1')
      const rest = await fillContrast('.scroll-to-bottom')
      if (!rest) throw new Error('scroll-to-bottom not found')
      expect(rest.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
      await saveAppScreenshot(`scroll-to-bottom-${theme}.png`)

      await $('.scroll-to-bottom').moveTo()
      await browser.pause(300)
      const hovered = await fillContrast('.scroll-to-bottom')
      if (!hovered) throw new Error('scroll-to-bottom not found')
      expect(hovered.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
    }
  })

  it('clicking scroll-to-bottom scrolls the view to the bottom', async () => {
    resetUserData()
    seedScrollToBottomFixture(process.cwd())
    await browser.reloadSession()

    await $('.messages-list .msg-user').waitForExist({ timeout: 30_000 })
    await scrollMessagesListToTop()
    expect(await isNearBottom()).toBe(false)

    await $('.scroll-to-bottom').click()

    expect(await isNearBottom()).toBe(true)
    expect(await isScrollToBottomVisible()).toBe(false)

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
    expect(lastMessageVisible).toBe(true)

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

    expect(await isNearBottom()).toBe(true)
    expect(await isScrollToBottomVisible()).toBe(false)

    // More tokens arrive while still pinned to the bottom.
    await browser.pause(400)

    expect(await isNearBottom()).toBe(true)
    expect(await isScrollToBottomVisible()).toBe(false)

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

    expect(await isScrollToBottomVisible()).toBe(true)
    const firstQuestionVisible = await browser.execute(() => {
      const firstUser = document.querySelector('.messages-list .msg-user')
      if (!(firstUser instanceof HTMLElement)) return false
      const list = document.querySelector('.messages-list')
      if (!(list instanceof HTMLElement)) return false
      const listRect = list.getBoundingClientRect()
      const msgRect = firstUser.getBoundingClientRect()
      return msgRect.top >= listRect.top - 4 && msgRect.top <= listRect.bottom
    })
    expect(firstQuestionVisible).toBe(true)

    await saveAppScreenshot('scroll-to-bottom-streaming-scrolled-up.png')
    await waitForAgentIdle()
    await scenario.assertComplete()
  })
})
