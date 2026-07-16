import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedConversationVisualHierarchyFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

interface AccentSnapshot {
  accentColor: string
  textOnAccent: string
  submitBackground: string
  submitColor: string
  linkColor: string
  userBackground: string
  selectedBackground: string
}

async function accentSnapshot(): Promise<AccentSnapshot | null> {
  return browser.execute(() => {
    const root = document.documentElement
    const submit = document.querySelector<HTMLElement>('.submit-btn')
    const link = document.querySelector<HTMLElement>(
      '[data-message-id="msg-assistant-result"] .message-text a',
    )
    const user = document.querySelector<HTMLElement>('[data-message-id="msg-user-hierarchy"]')
    const selected = document.querySelector<HTMLElement>('.chat-row.selected')
    if (!submit || !link || !user || !selected) return null
    const rootStyle = getComputedStyle(root)
    return {
      accentColor: rootStyle.getPropertyValue('--accent-color').trim().toLowerCase(),
      textOnAccent: rootStyle.getPropertyValue('--text-on-accent').trim().toLowerCase(),
      submitBackground: getComputedStyle(submit).backgroundColor,
      submitColor: getComputedStyle(submit).color,
      linkColor: getComputedStyle(link).color,
      userBackground: getComputedStyle(user).backgroundColor,
      selectedBackground: getComputedStyle(selected).backgroundColor,
    }
  })
}

describe('custom accent colour', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedConversationVisualHierarchyFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-result"] .message-text a').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('uses teal by default and applies a saved custom hue across interaction surfaces', async () => {
    const defaults = await accentSnapshot()
    expect(defaults).not.toBeNull()
    expect(defaults?.accentColor).toBe('#2a9d8f')
    expect(defaults?.textOnAccent).toBe('#101918')
    expect(defaults?.submitBackground).toBe('rgb(42, 157, 143)')
    expect(defaults?.submitColor).toBe('rgb(16, 25, 24)')
    expect(defaults?.linkColor).not.toBe('rgb(88, 166, 255)')
    await saveAppScreenshot('accent-default-teal.png')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    const accentInput = await $('input[name="uiAccentColor"]')
    await accentInput.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(async () => (await accentInput.getValue()) !== '', {
      timeout: 30_000,
      timeoutMsg: 'expected the saved/default accent to load into Appearance settings',
    })
    expect((await accentInput.getValue()).toLowerCase()).toBe('#2a9d8f')
    const combinedPanel = await browser.execute(() => {
      const accent = document.querySelector<HTMLInputElement>('input[name="uiAccentColor"]')
      const tint = document.querySelector<HTMLInputElement>('input[name="uiTintColor"]')
      const accentFieldset = accent?.closest('fieldset')
      return {
        sameFieldset: accentFieldset != null && accentFieldset === tint?.closest('fieldset'),
        legend: accentFieldset?.querySelector('legend')?.textContent?.trim() ?? '',
      }
    })
    expect(combinedPanel.sameFieldset).toBe(true)
    expect(combinedPanel.legend).toBe('Interface colours')
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('input[name="uiAccentColor"]')
      if (!input) return
      input.value = '#7c3aed'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await saveElementScreenshot('#settings-dialog', 'accent-settings.png')
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })

    await browser.waitUntil(async () => (await accentSnapshot())?.accentColor === '#7c3aed', {
      timeout: 10_000,
      timeoutMsg: 'expected the custom accent to apply after saving settings',
    })
    const custom = await accentSnapshot()
    expect(custom).not.toBeNull()
    expect(custom?.submitBackground).toBe('rgb(124, 58, 237)')
    expect(custom?.submitColor).toBe('rgb(255, 255, 255)')
    expect(custom?.linkColor).not.toBe(defaults?.linkColor)
    expect(custom?.userBackground).not.toBe(defaults?.userBackground)
    expect(custom?.selectedBackground).not.toBe(defaults?.selectedBackground)
    await saveAppScreenshot('accent-custom-purple.png')
  })
})
