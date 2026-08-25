import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedConversationVisualHierarchyFixture } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

interface UiScaleSnapshot {
  /** Inline --ui-scale written by applyUiScale / restoreUiScale. */
  uiScaleInline: string
  bodyFontSize: string
  spacingSmPx: string
}

async function uiScaleSnapshot(): Promise<UiScaleSnapshot | null> {
  return browser.execute(() => {
    const body = document.body
    if (!body) return null
    const probe = document.createElement('div')
    probe.style.width = 'var(--spacing-sm)'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    body.appendChild(probe)
    const spacingSmPx = getComputedStyle(probe).width
    probe.remove()
    return {
      uiScaleInline: document.documentElement.style.getPropertyValue('--ui-scale').trim(),
      bodyFontSize: getComputedStyle(body).fontSize,
      spacingSmPx,
    }
  })
}

interface VisualViewportSnapshot {
  scale: number
  width: number
  height: number
  innerWidth: number
  innerHeight: number
  offsetLeft: number
  offsetTop: number
}

async function visualViewportSnapshot(): Promise<VisualViewportSnapshot | null> {
  return browser.execute(() => {
    const viewport = window.visualViewport
    if (!viewport) return null
    return {
      scale: viewport.scale,
      width: viewport.width,
      height: viewport.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      offsetLeft: viewport.offsetLeft,
      offsetTop: viewport.offsetTop,
    }
  })
}

describe('interface scale (--ui-scale)', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedConversationVisualHierarchyFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-result"]').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('defaults to 1 and scales tokens after saving Appearance', async () => {
    const defaults = await uiScaleSnapshot()
    expect(defaults).not.toBeNull()
    expect(defaults?.uiScaleInline).toBe('1')
    expect(defaults?.bodyFontSize).toBe('14px')
    expect(defaults?.spacingSmPx).toBe('8px')

    const visualViewport = await visualViewportSnapshot()
    expect(visualViewport).not.toBeNull()
    expect(visualViewport?.scale).toBe(1)
    expect(Math.abs((visualViewport?.width ?? 0) - (visualViewport?.innerWidth ?? 0))).toBeLessThan(
      1,
    )
    expect(
      Math.abs((visualViewport?.height ?? 0) - (visualViewport?.innerHeight ?? 0)),
    ).toBeLessThan(1)
    expect(visualViewport?.offsetLeft).toBe(0)
    expect(visualViewport?.offsetTop).toBe(0)
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'ui-scale-native-window-default.png'))
    await saveAppScreenshot('ui-scale-default.png')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    const scaleInput = await $('input[name="uiScale"]')
    await scaleInput.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(async () => (await scaleInput.getValue()) !== '', {
      timeout: 30_000,
      timeoutMsg: 'expected uiScale to load into Appearance settings',
    })
    expect(await scaleInput.getValue()).toBe('1')

    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('input[name="uiScale"]')
      if (!input) return
      input.value = '1.25'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await saveElementScreenshot('#settings-dialog', 'ui-scale-settings.png')
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.settings-buttons button[type="submit"]')?.click()
    })
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })

    await browser.waitUntil(async () => (await uiScaleSnapshot())?.uiScaleInline === '1.25', {
      timeout: 10_000,
      timeoutMsg: 'expected --ui-scale=1.25 after saving settings',
    })
    const scaled = await uiScaleSnapshot()
    expect(scaled?.uiScaleInline).toBe('1.25')
    // 14px * 1.25 = 17.5px; spacing-sm 8px * 1.25 = 10px
    expect(scaled?.bodyFontSize).toBe('17.5px')
    expect(scaled?.spacingSmPx).toBe('10px')
    await saveAppScreenshot('ui-scale-125.png')
  })

  it('does not intercept Chromium pinch-shaped wheel events', async () => {
    const before = await uiScaleSnapshot()
    expect(before).not.toBeNull()

    const defaultPrevented = await browser.execute(() => {
      const event = new WheelEvent('wheel', {
        ctrlKey: true,
        deltaY: -120,
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })

    expect(defaultPrevented).toBe(false)
    expect((await uiScaleSnapshot())?.uiScaleInline).toBe(before?.uiScaleInline)
  })

  it('steps with the Zoom In keyboard shortcut', async () => {
    // Start from the scaled state left by the previous tests (1.25 → 1.35).
    // Dispatch the chord in-page so we exercise the renderer keydown path
    // (WebdriverIO chord synthesis is flaky for Ctrl+= across platforms).
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '=',
          code: 'Equal',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await browser.waitUntil(async () => (await uiScaleSnapshot())?.uiScaleInline === '1.35', {
      timeout: 10_000,
      timeoutMsg: 'expected Ctrl+= to bump uiScale from 1.25 to 1.35',
    })
    await saveAppScreenshot('ui-scale-keyboard-135.png')
  })
})
