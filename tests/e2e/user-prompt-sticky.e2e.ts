import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStickyUserPromptFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('latest user prompt anchor', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedStickyUserPromptFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-sticky-result"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('right-aligns user bubbles and keeps only the latest prompt visible at the top', async () => {
    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = list.scrollHeight
    })
    await browser.pause(100)

    const layout = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const first = document.querySelector('[data-message-id="msg-user-sticky-first"]')
      const latest = document.querySelector('[data-message-id="msg-user-sticky-latest"]')
      const answer = document.querySelector('[data-message-id="msg-assistant-sticky-result"]')
      if (!list || !first || !latest || !answer) return { error: 'missing sticky fixture element' }

      const listRect = list.getBoundingClientRect()
      const firstRect = first.getBoundingClientRect()
      const latestRect = latest.getBoundingClientRect()
      const answerRect = answer.getBoundingClientRect()
      const userMessages = [...list.querySelectorAll('.msg-user')]
      return {
        listTop: listRect.top,
        listBottom: listRect.bottom,
        listPaddingTop: Number.parseFloat(getComputedStyle(list).paddingTop),
        firstBottom: firstRect.bottom,
        latestTop: latestRect.top,
        latestBottom: latestRect.bottom,
        rightEdgeDelta: Math.abs(latestRect.right - answerRect.right),
        latestPosition: getComputedStyle(latest).position,
        stickyUserCount: userMessages.filter(
          (message) => getComputedStyle(message).position === 'sticky',
        ).length,
        scrollable: list.scrollHeight > list.clientHeight,
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.scrollable).toBe(true)
    expect(layout.latestPosition).toBe('sticky')
    expect(layout.stickyUserCount).toBe(1)
    expect(
      Math.abs(layout.latestTop - (layout.listTop + layout.listPaddingTop - 16)),
    ).toBeLessThanOrEqual(1)
    expect(layout.latestBottom).toBeLessThan(layout.listBottom)
    expect(layout.firstBottom).toBeLessThan(layout.listTop)
    expect(layout.rightEdgeDelta).toBeLessThanOrEqual(1)

    await saveAppScreenshot('user-prompt-sticky.png')
  })

  it('returns the latest prompt to the transcript when the chat pane is narrow', async () => {
    await browser.execute(() => {
      const app = document.getElementById('app')
      if (app) app.style.width = '600px'
      window.dispatchEvent(new Event('resize'))
      const answer = document.querySelector('[data-message-id="msg-assistant-sticky-result"]')
      answer?.scrollIntoView({ block: 'end' })
    })
    await browser.pause(100)

    const layout = await browser.execute(() => {
      const chat = document.getElementById('pane-chat')
      const list = document.querySelector('.messages-list')
      const latest = document.querySelector('[data-message-id="msg-user-sticky-latest"]')
      const answer = document.querySelector('[data-message-id="msg-assistant-sticky-result"]')
      const composer = document.getElementById('input-bar')
      if (!chat || !list || !latest || !answer || !composer) {
        return { error: 'missing narrow sticky fixture element' }
      }

      const chatRect = chat.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      const latestRect = latest.getBoundingClientRect()
      const answerRect = answer.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      return {
        chatWidth: chatRect.width,
        latestPosition: getComputedStyle(latest).position,
        latestBottom: latestRect.bottom,
        answerTop: answerRect.top,
        answerBottom: answerRect.bottom,
        visibleTop: listRect.top,
        visibleBottom: Math.min(listRect.bottom, composerRect.top),
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.chatWidth).toBeLessThanOrEqual(360)
    expect(layout.latestPosition).toBe('relative')
    expect(layout.latestBottom).toBeLessThanOrEqual(layout.answerTop)
    expect(layout.answerBottom).toBeGreaterThan(layout.visibleTop)
    expect(layout.answerBottom).toBeLessThanOrEqual(layout.visibleBottom + 1)

    await saveAppScreenshot('user-prompt-narrow-chat.png', { width: 600, height: 800 })
  })
})
