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
    const initialDisclosureState = await browser.execute(() => ({
      reasoningOpen: document.querySelector('.message-reasoning')?.hasAttribute('open') ?? false,
      toolOpen:
        document.querySelector('.tool-card[data-status="done"]')?.hasAttribute('open') ?? false,
    }))
    // Completed trace details stay compact: reasoning and done tools both start
    // closed, so the outcome carries the turn.
    expect(initialDisclosureState.reasoningOpen).toBe(false)
    expect(initialDisclosureState.toolOpen).toBe(false)

    const layout = await browser.execute(() => {
      const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect()
      const pane = rect('#pane-chat')
      const messagesList = document.querySelector<HTMLElement>('.messages-list')
      const user = rect('[data-message-id="msg-user-hierarchy"]')
      const trace = rect('[data-message-id="msg-assistant-check"]')
      const todoPanel = rect('.conversation-todos-host .plugin-panel')
      const answerElement = document.querySelector('[data-message-id="msg-assistant-result"]')
      const answer = answerElement?.getBoundingClientRect()
      const reviewElement = document.querySelector('[data-review-card]')
      const review = reviewElement?.getBoundingClientRect()
      const comparisonElement = document.querySelector('[data-comparison-card]')
      const comparison = comparisonElement?.getBoundingClientRect()
      const composer = rect('#input-bar')
      const composerInput = document.querySelector('.prompt-input')
      const closedReasoning = document.querySelector('.message-reasoning:not([open])')
      const reasoningText = document.querySelector('.message-reasoning-text')
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
        !composerInput ||
        !closedReasoning ||
        !reasoningText ||
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
      const baseLineHeight = getComputedStyle(document.body).lineHeight
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
        baseLineHeight,
        answerLineHeight: answerStyle.lineHeight,
        reasoningLineHeight: getComputedStyle(reasoningText).lineHeight,
        composerLineHeight: getComputedStyle(composerInput).lineHeight,
        sidebarLineHeight: selectedStyle.lineHeight,
        reviewLineHeight: reviewStyle.lineHeight,
        comparisonLineHeight: comparisonStyle.lineHeight,
      }
    })

    expect(layout).not.toHaveProperty('error')
    // Below the user-message width cap, both surfaces fill the available column.
    expect(layout.userWidth).toBeLessThanOrEqual(layout.traceWidth)
    expect(layout.userWidth).toBeLessThanOrEqual(842)
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
    expect(layout.answerFontSize).toBe('16px')
    expect(layout.answerTopBorder).toBe('0px')
    expect(layout.titlebarBorderColor).toMatch(/rgba\([^)]*, 0\)|transparent/)
    expect(layout.selectedRadius).toBe('0px')
    // Review and comparison are annotations on the turn, not part of the answer,
    // so they take the hatched plate rather than a rail and a fading wash: same
    // box as the agent's own callouts, different material. The radius is what a
    // rail could never have had — it would have bowed around the corner. See
    // docs/ui-taste.md -> "Transcript status callouts".
    expect(layout.reviewRadius).toBe('6px')
    expect(layout.reviewTopBorder).toBe('0px')
    expect(layout.reviewLeftBorder).toBe('0px')
    expect(layout.reviewBackground).toContain('repeating-linear-gradient')
    expect(layout.comparisonRadius).toBe('6px')
    expect(layout.comparisonTopBorder).toBe('0px')
    expect(layout.comparisonLeftBorder).toBe('0px')
    expect(layout.comparisonBackground).toContain('repeating-linear-gradient')
    expect(layout.baseLineHeight).toBe('22px')
    expect(parseFloat(layout.answerLineHeight ?? '')).toBeCloseTo(26.4, 1)
    expect(layout.reasoningLineHeight).toBe(layout.baseLineHeight)
    expect(layout.composerLineHeight).toBe(layout.baseLineHeight)
    expect(layout.sidebarLineHeight).toBe(layout.baseLineHeight)
    expect(layout.reviewLineHeight).toBe(layout.baseLineHeight)
    expect(layout.comparisonLineHeight).toBe(layout.baseLineHeight)

    // Exercise the distinct reading widths independently of the default sidebar width.
    const wideLayout = await browser.execute(() => {
      const app = document.getElementById('app')
      if (!app) throw new Error('missing app shell')
      app.style.width = '1600px'
      const user = document.querySelector('[data-message-id="msg-user-hierarchy"]')
      const trace = document.querySelector('[data-message-id="msg-assistant-check"]')
      if (!user || !trace) throw new Error('missing hierarchy messages')
      return {
        userWidth: user.getBoundingClientRect().width,
        traceWidth: trace.getBoundingClientRect().width,
      }
    })
    expect(wideLayout.userWidth).toBeLessThan(wideLayout.traceWidth)
    expect(wideLayout.userWidth).toBeLessThanOrEqual(842)
    await saveAppScreenshot('conversation-visual-hierarchy.png')
  })
})
