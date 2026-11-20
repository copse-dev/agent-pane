import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedConversationVisualHierarchyFixture,
  seedE2eViewport,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

/**
 * Selected text has to stay readable, and the app cannot lean on Chromium for
 * that: with no author `::selection`, an unfocused window repaints the
 * selection in a flat grey while leaving the text its own colour, which is how
 * dark-theme prose ended up highlighted-but-invisible. base.css now declares
 * the pair, so this spec pins the resolved colours and their contrast in both
 * themes and captures a live selection for visual inspection.
 */
interface HighlightSnapshot {
  /** `background` / `color` as authored on the ::selection rule. */
  rule: { background: string; color: string } | null
  replyRule: { background: string; color: string } | null
  selectionBackground: string
  selectionText: string
  selectionContrast: number
  currentMatchContrast: number
  selectedText: string
}

async function highlightSnapshot(): Promise<HighlightSnapshot | null> {
  return browser.execute(() => {
    const root = document.documentElement
    const style = getComputedStyle(root)
    const token = (name: string): string => style.getPropertyValue(name).trim()
    // getComputedStyle cannot resolve highlight pseudos, so read the rule the
    // stylesheet actually carries and resolve its var() through the tokens.
    let rule: { background: string; color: string } | null = null
    let replyRule: { background: string; color: string } | null = null
    for (const sheet of Array.from(document.styleSheets)) {
      for (const cssRule of Array.from(sheet.cssRules)) {
        if (!(cssRule instanceof CSSStyleRule)) continue
        const colors = {
          background: cssRule.style.getPropertyValue('background').trim(),
          color: cssRule.style.getPropertyValue('color').trim(),
        }
        if (cssRule.selectorText === '::selection') rule = colors
        if (cssRule.selectorText === '::highlight(transcript-reply-selection)') replyRule = colors
      }
    }
    const luminance = (hex: string): number => {
      const channel = (offset: number): number => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
    }
    const contrast = (a: string, b: string): number => {
      const first = luminance(a)
      const second = luminance(b)
      const light = Math.max(first, second)
      const dark = Math.min(first, second)
      return (light + 0.05) / (dark + 0.05)
    }
    const selectionText = window.getSelection()?.toString() ?? ''
    return {
      rule,
      replyRule,
      selectionBackground: token('--selection-bg'),
      selectionText: token('--selection-text'),
      selectionContrast: contrast(token('--selection-bg'), token('--selection-text')),
      currentMatchContrast: contrast(
        token('--highlight-current-bg'),
        token('--highlight-current-text'),
      ),
      // Autofocus moves the native selection into the reply textarea. The
      // passage is now painted by the captured CSS Highlight instead.
      selectedText: (selectionText.length > 0
        ? selectionText
        : [...(CSS.highlights.get('transcript-reply-selection') ?? [])]
            .map((range) => (range instanceof Range ? range.toString() : ''))
            .join('')
      ).trim(),
    }
  })
}

/** Drag-select the assistant's rendered markdown, the way a user copying it would. */
async function selectAssistantText(): Promise<string> {
  await recordReplyDismissals()
  const text = await browser.execute(() => {
    const paragraph = document.querySelector<HTMLElement>(
      '[data-message-id="msg-assistant-result"] .message-text p',
    )
    const selection = window.getSelection()
    if (!paragraph || !selection) throw new Error('assistant paragraph or selection missing')
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    selection.removeAllRanges()
    selection.addRange(range)
    return paragraph.textContent.trim()
  })
  await $('.transcript-selection-reply').waitForDisplayed({ timeout: 5_000 })
  return text
}

declare global {
  interface Window {
    /** Events that can dismiss the selection reply, logged from just before the selection. */
    e2eSelectionReplyEvents?: string[]
  }
}

/**
 * Log what could dismiss the reply after the selection is made: a window blur,
 * any scroll (the reply listens in the capture phase, so any element counts),
 * focus moving away, or the selected row being replaced. A failed visibility
 * check reports this log, so a capture race names its cause.
 */
async function recordReplyDismissals(): Promise<void> {
  await browser.execute(() => {
    const events: string[] = []
    window.e2eSelectionReplyEvents = events
    const started = performance.now()
    const describe = (target: EventTarget | null): string => {
      if (target === document) return 'document'
      if (!(target instanceof Element)) return 'window'
      const classes = [...target.classList].map((name) => `.${name}`).join('')
      return `${target.tagName.toLowerCase()}${classes}`
    }
    const log = (entry: string): void => {
      if (window.e2eSelectionReplyEvents !== events) return
      events.push(`${(performance.now() - started).toFixed(0)}ms ${entry}`)
    }
    window.addEventListener('blur', () => {
      log('window blur')
    })
    document.addEventListener(
      'scroll',
      (event) => {
        log(`scroll ${describe(event.target)}`)
      },
      true,
    )
    document.addEventListener('focusin', (event) => {
      log(`focus ${describe(event.target)}`)
    })
    const row = document.querySelector('[data-message-id="msg-assistant-result"]')
    if (row?.parentElement) {
      new MutationObserver(() => {
        if (!row.isConnected) log('selected row replaced')
      }).observe(row.parentElement, { childList: true })
    }
  })
}

/**
 * What the capture must show: the passage painted as selected and the reply
 * box open beside it. `highlightSnapshot` only proves the selection existed
 * when it ran; the shell resize, layout and index waits in `saveAppScreenshot`
 * all come after it. Anything in between that dismisses the reply (a scroll, a
 * window blur, a re-render) clears the highlight and closes the box, so check
 * both again inside the capture frame and once more after it. Dismissal never
 * reopens by itself, so state that survives the capture was in the frame.
 */
async function expectSelectionReplyVisible(expectedText: string): Promise<void> {
  const state = await browser.execute(() => {
    const native = window.getSelection()?.toString() ?? ''
    const painted = [...(CSS.highlights.get('transcript-reply-selection') ?? [])]
      .map((range) => (range instanceof Range ? range.toString() : ''))
      .join('')
    const popup = document.querySelector<HTMLElement>('.transcript-selection-quote')
    const reply = document.querySelector<HTMLElement>('.transcript-selection-reply')
    const box = reply?.getBoundingClientRect()
    return {
      selectedText: (native.length > 0 ? native : painted).trim(),
      popupHidden: popup?.hidden ?? true,
      replyVisible:
        reply !== null &&
        box !== undefined &&
        box.width > 0 &&
        box.height > 0 &&
        reply.checkVisibility(),
      replyFocused: reply !== null && document.activeElement === reply,
      events: window.e2eSelectionReplyEvents ?? [],
    }
  })
  const { events, ...visible } = state
  const shown =
    visible.selectedText === expectedText &&
    !visible.popupHidden &&
    visible.replyVisible &&
    visible.replyFocused
  if (!shown) {
    throw new Error(
      `The selection reply was dismissed before the capture: ${JSON.stringify(visible)}\n` +
        `Events since the selection:\n${events.join('\n') || '(none)'}`,
    )
  }
  expect(state.selectedText.length).toBeGreaterThan(0)
  expect(state.selectedText).toBe(expectedText)
  expect(state.popupHidden).toBe(false)
  expect(state.replyVisible).toBe(true)
  expect(state.replyFocused).toBe(true)
}

async function switchTheme(theme: 'light' | 'dark'): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('.settings-nav-btn[data-section="appearance"]').click()
  await $('select[name="theme"]').waitForDisplayed({ timeout: 30_000 })
  await browser.execute((next) => {
    const select = document.querySelector<HTMLSelectElement>('select[name="theme"]')
    if (!select) return
    select.value = next
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, theme)
  await $('.settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
  await browser.waitUntil(
    async () =>
      browser.execute((next) => document.documentElement.dataset['theme'] === next, theme),
    { timeout: 10_000, timeoutMsg: `expected the ${theme} theme to apply` },
  )
}

/**
 * The seeded plan's three completed rows are painted at full height inside the
 * TODO panel, none clipped by its row cap or the scroll area. The panel renders
 * and caps its rows a frame after the thread mounts, so a capture taken on
 * arrival can catch it mid-layout.
 */
async function waitForTodoRowsSettled(expected: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((count) => {
        const list = document.querySelector('.conversation-todos-host .plugin-panel-list')
        if (!(list instanceof HTMLElement)) return false
        const rows = Array.from(list.querySelectorAll('.plugin-panel-row'))
        if (rows.length !== count) return false
        const box = list.getBoundingClientRect()
        return (
          list.scrollHeight <= list.clientHeight + 1 &&
          rows.every((row) => {
            const rect = row.getBoundingClientRect()
            return rect.height >= 16 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5
          })
        )
      }, expected),
    { timeout: 10_000, timeoutMsg: `expected ${String(expected)} unclipped TODO rows` },
  )
}

describe('selected text stays visible', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    seedConversationVisualHierarchyFixture(seedStableWorkspace())
    seedE2eViewport({ width: 1280, height: 800 })
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-result"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('highlights selected prose with a readable pair in both themes', async () => {
    const darkText = await selectAssistantText()
    const dark = await highlightSnapshot()
    expect(dark).not.toBeNull()
    // The rule must set both halves: a background alone leaves the text its own
    // colour, which is exactly the unreadable UA behaviour being replaced.
    expect(dark?.rule).toEqual({
      background: 'var(--selection-bg)',
      color: 'var(--selection-text)',
    })
    expect(dark?.replyRule).toEqual(dark?.rule)
    expect(dark?.selectionBackground).toBe('#2f6fd0')
    expect(dark?.selectionText).toBe('#ffffff')
    expect(dark?.selectionContrast).toBeGreaterThanOrEqual(4.5)
    expect(dark?.currentMatchContrast).toBeGreaterThanOrEqual(4.5)
    expect(darkText.length).toBeGreaterThan(0)
    expect(dark?.selectedText).toBe(darkText)
    await waitForTodoRowsSettled(3)
    await saveAppScreenshot('selection-highlight-dark.png', undefined, () =>
      expectSelectionReplyVisible(darkText),
    )
    await expectSelectionReplyVisible(darkText)

    await switchTheme('light')
    const lightText = await selectAssistantText()
    const light = await highlightSnapshot()
    expect(light?.selectionBackground).toBe('#b0d3ff')
    expect(light?.selectionText).toBe('#10243b')
    expect(light?.selectionContrast).toBeGreaterThanOrEqual(4.5)
    expect(light?.replyRule).toEqual(light?.rule)
    expect(light?.selectedText).toBe(lightText)
    // The light theme darkens --accent while --text-on-accent tracks the raw
    // accent, so the current search match must not be built from that pair.
    expect(light?.currentMatchContrast).toBeGreaterThanOrEqual(4.5)
    await waitForTodoRowsSettled(3)
    await saveAppScreenshot('selection-highlight-light.png', undefined, () =>
      expectSelectionReplyVisible(lightText),
    )
    await expectSelectionReplyVisible(lightText)
  })
})
