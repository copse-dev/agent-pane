import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedConversationVisualHierarchyFixture,
  seedE2eViewport,
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
    for (const sheet of Array.from(document.styleSheets)) {
      for (const cssRule of Array.from(sheet.cssRules)) {
        if (!(cssRule instanceof CSSStyleRule) || cssRule.selectorText !== '::selection') continue
        rule = {
          background: cssRule.style.getPropertyValue('background').trim(),
          color: cssRule.style.getPropertyValue('color').trim(),
        }
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
    return {
      rule,
      selectionBackground: token('--selection-bg'),
      selectionText: token('--selection-text'),
      selectionContrast: contrast(token('--selection-bg'), token('--selection-text')),
      currentMatchContrast: contrast(
        token('--highlight-current-bg'),
        token('--highlight-current-text'),
      ),
      selectedText: (window.getSelection()?.toString() ?? '').trim(),
    }
  })
}

/** Drag-select the assistant's rendered markdown, the way a user copying it would. */
async function selectAssistantText(): Promise<void> {
  await browser.execute(() => {
    const paragraph = document.querySelector<HTMLElement>(
      '[data-message-id="msg-assistant-result"] .message-text p',
    )
    const selection = window.getSelection()
    if (!paragraph || !selection) return
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    selection.removeAllRanges()
    selection.addRange(range)
  })
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

describe('selected text stays visible', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedConversationVisualHierarchyFixture(process.cwd())
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
    await selectAssistantText()
    const dark = await highlightSnapshot()
    expect(dark).not.toBeNull()
    // The rule must set both halves: a background alone leaves the text its own
    // colour, which is exactly the unreadable UA behaviour being replaced.
    expect(dark?.rule).toEqual({
      background: 'var(--selection-bg)',
      color: 'var(--selection-text)',
    })
    expect(dark?.selectionBackground).toBe('#2f6fd0')
    expect(dark?.selectionText).toBe('#ffffff')
    expect(dark?.selectionContrast).toBeGreaterThanOrEqual(4.5)
    expect(dark?.currentMatchContrast).toBeGreaterThanOrEqual(4.5)
    expect(dark?.selectedText.length).toBeGreaterThan(0)
    await saveAppScreenshot('selection-highlight-dark.png')

    await switchTheme('light')
    await selectAssistantText()
    const light = await highlightSnapshot()
    expect(light?.selectionBackground).toBe('#b0d3ff')
    expect(light?.selectionText).toBe('#10243b')
    expect(light?.selectionContrast).toBeGreaterThanOrEqual(4.5)
    // The light theme darkens --accent while --text-on-accent tracks the raw
    // accent, so the current search match must not be built from that pair.
    expect(light?.currentMatchContrast).toBeGreaterThanOrEqual(4.5)
    await saveAppScreenshot('selection-highlight-light.png')
  })
})
