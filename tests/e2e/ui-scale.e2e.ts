import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedConversationVisualHierarchyFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

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
    await $('.settings-buttons button[type="submit"]').click()
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

  it('steps with the Zoom In keyboard shortcut', async () => {
    // Start from the scaled state left by the previous test (1.25 → 1.35).
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
