import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedConversationVisualHierarchyFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('conversation visual hierarchy', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedConversationVisualHierarchyFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-result"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('keeps the outcome prominent while completed trace details stay compact', async () => {
    const reasoning = await $('.message-reasoning')
    const initialDisclosureState = await browser.execute(() => ({
      reasoningOpen: document.querySelector('.message-reasoning')?.hasAttribute('open') ?? false,
      toolOpen:
        document.querySelector('.tool-card[data-status="done"]')?.hasAttribute('open') ?? false,
    }))
    expect(initialDisclosureState.reasoningOpen).toBe(true)
    expect(initialDisclosureState.toolOpen).toBe(false)

    // Exercise the compact completed-trace treatment without changing the
    // product's disclosure-state behavior as part of this visual-only change.
    await reasoning.$('.message-reasoning-summary').click()
    await browser.waitUntil(
      async () =>
        !(await browser.execute(
          () => document.querySelector('.message-reasoning')?.hasAttribute('open') ?? false,
        )),
      { timeout: 2_000, timeoutMsg: 'expected reasoning disclosure to collapse' },
    )

    const layout = await browser.execute(() => {
      const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect()
      const pane = rect('#pane-chat')
      const messagesList = document.querySelector<HTMLElement>('.messages-list')
      const user = rect('[data-message-id="msg-user-hierarchy"]')
      const trace = rect('[data-message-id="msg-assistant-check"]')
      const todoPanel = rect('.conversation-todos-host .todo-panel')
      const answerElement = document.querySelector('[data-message-id="msg-assistant-result"]')
      const answer = answerElement?.getBoundingClientRect()
      const reviewElement = document.querySelector('[data-review-card]')
      const review = reviewElement?.getBoundingClientRect()
      const comparisonElement = document.querySelector('[data-comparison-card]')
      const comparison = comparisonElement?.getBoundingClientRect()
      const composer = rect('#input-bar')
      const closedReasoning = document.querySelector('.message-reasoning:not([open])')
      const doneTool = document.querySelector('.tool-card[data-status="done"]:not([open])')
      const answerText = document.querySelector(
        '[data-message-id="msg-assistant-result"] .message-text',
      )
      const secondaryTitlebarButton = document.querySelector(
        '.titlebar-panel-controls > .titlebar-text-btn',
      )
      const selectedThread = document.querySelector('.chat-row.selected')
      if (
        !pane ||
        !messagesList ||
        !user ||
        !trace ||
        !todoPanel ||
        !answer ||
        !review ||
        !reviewElement ||
        !comparison ||
        !comparisonElement ||
        !composer ||
        !closedReasoning ||
        !doneTool ||
        !answerText ||
        !secondaryTitlebarButton ||
        !selectedThread
      ) {
        return { error: 'missing hierarchy fixture element' }
      }

      const reasoningStyle = getComputedStyle(closedReasoning)
      const answerStyle = getComputedStyle(answerText)
      const titlebarStyle = getComputedStyle(secondaryTitlebarButton)
      const selectedStyle = getComputedStyle(selectedThread)
      const reviewStyle = getComputedStyle(reviewElement)
      const comparisonStyle = getComputedStyle(comparisonElement)
      const messagesListRect = messagesList.getBoundingClientRect()
      const messagesListContentCenter = messagesListRect.left + messagesList.clientWidth / 2
      return {
        paneWidth: pane.width,
        messagesListScrollbarGutter: messagesList.offsetWidth - messagesList.clientWidth,
        userWidth: user.width,
        traceWidth: trace.width,
        todoWidth: todoPanel.width,
        answerWidth: answer.width,
        reviewWidth: review.width,
        comparisonWidth: comparison.width,
        composerWidth: composer.width,
        composerCenterDelta: Math.abs(
          composer.left + composer.width / 2 - (pane.left + pane.width / 2),
        ),
        todoCenterDelta: Math.abs(
          todoPanel.left + todoPanel.width / 2 - (pane.left + pane.width / 2),
        ),
        reviewCenterDelta: Math.abs(review.left + review.width / 2 - messagesListContentCenter),
        comparisonCenterDelta: Math.abs(
          comparison.left + comparison.width / 2 - messagesListContentCenter,
        ),
        composerBottomGap: pane.bottom - composer.bottom,
        reasoningBorderWidth: reasoningStyle.borderLeftWidth,
        doneToolHeight: doneTool.getBoundingClientRect().height,
        answerFontSize: answerStyle.fontSize,
        answerTopBorder: getComputedStyle(answerElement ?? answerText).borderTopWidth,
        titlebarBorderColor: titlebarStyle.borderColor,
        selectedRadius: selectedStyle.borderRadius,
        reviewRadius: reviewStyle.borderRadius,
        reviewTopBorder: reviewStyle.borderTopWidth,
        reviewLeftBorder: reviewStyle.borderLeftWidth,
        reviewBackground: reviewStyle.backgroundImage,
        comparisonRadius: comparisonStyle.borderRadius,
        comparisonTopBorder: comparisonStyle.borderTopWidth,
        comparisonLeftBorder: comparisonStyle.borderLeftWidth,
        comparisonBackground: comparisonStyle.backgroundImage,
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.userWidth).toBeLessThan(layout.traceWidth)
    expect(layout.traceWidth).toBeLessThanOrEqual(962)
    expect(layout.todoWidth).toBeLessThanOrEqual(962)
    expect(Math.abs(layout.todoWidth - layout.traceWidth)).toBeLessThanOrEqual(
      layout.messagesListScrollbarGutter + 1,
    )
    expect(layout.answerWidth).toBeLessThanOrEqual(962)
    expect(Math.abs(layout.reviewWidth - layout.traceWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.comparisonWidth - layout.traceWidth)).toBeLessThanOrEqual(1)
    expect(layout.composerWidth).toBeLessThanOrEqual(962)
    expect(layout.composerWidth).toBeLessThan(layout.paneWidth)
    expect(layout.composerCenterDelta).toBeLessThanOrEqual(1)
    expect(layout.todoCenterDelta).toBeLessThanOrEqual(1)
    expect(layout.reviewCenterDelta).toBeLessThanOrEqual(1)
    expect(layout.comparisonCenterDelta).toBeLessThanOrEqual(1)
    expect(layout.composerBottomGap).toBeGreaterThanOrEqual(11)
    expect(layout.composerBottomGap).toBeLessThanOrEqual(13)
    expect(layout.reasoningBorderWidth).toBe('0px')
    expect(layout.doneToolHeight).toBeLessThan(36)
    expect(layout.answerFontSize).toBe('15px')
    expect(layout.answerTopBorder).toBe('1px')
    expect(layout.titlebarBorderColor).toMatch(/rgba\([^)]*, 0\)|transparent/)
    expect(layout.selectedRadius).toBe('0px')
    expect(layout.reviewRadius).toBe('0px')
    expect(layout.reviewTopBorder).toBe('0px')
    expect(layout.reviewLeftBorder).toBe('2px')
    expect(layout.reviewBackground).toContain('linear-gradient')
    expect(layout.comparisonRadius).toBe('0px')
    expect(layout.comparisonTopBorder).toBe('0px')
    expect(layout.comparisonLeftBorder).toBe('2px')
    expect(layout.comparisonBackground).toContain('linear-gradient')

    await saveAppScreenshot('conversation-visual-hierarchy.png')
  })
})
