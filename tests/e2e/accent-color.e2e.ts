import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedConversationVisualHierarchyFixture,
  seedE2eViewport,
} from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

interface AccentSnapshot {
  accentColor: string
  bodyBackground: string
  bodyFontFamily: string
  tintStrength: string
  textOnAccent: string
  submitBackground: string
  submitColor: string
  submitFontWeight: string
  submitHeight: number
  submitPaddingInline: string
  submitRadius: string
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
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      tintStrength: root.dataset['tintStrength'] ?? '',
      textOnAccent: rootStyle.getPropertyValue('--text-on-accent').trim().toLowerCase(),
      submitBackground: getComputedStyle(submit).backgroundColor,
      submitColor: getComputedStyle(submit).color,
      submitFontWeight: getComputedStyle(submit).fontWeight,
      submitHeight: submit.getBoundingClientRect().height,
      submitPaddingInline: getComputedStyle(submit).paddingInline,
      submitRadius: getComputedStyle(submit).borderRadius,
      linkColor: getComputedStyle(link).color,
      userBackground: getComputedStyle(user).backgroundColor,
      selectedBackground: getComputedStyle(selected).backgroundColor,
    }
  })
}

async function setTintStrength(strength: 'off' | 'subtle' | 'medium' | 'strong'): Promise<void> {
  await browser.execute((nextStrength) => {
    const input = document.querySelector<HTMLInputElement>('input[name="uiTintStrength"]')
    if (!input) return
    input.value = String(['off', 'subtle', 'medium', 'strong'].indexOf(nextStrength))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, strength)
}

describe('custom interface colours', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedConversationVisualHierarchyFixture(process.cwd())
    seedE2eViewport({ width: 1280, height: 800 }, { uiTintStrength: 'subtle' })
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-result"] .message-text a').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('uses the requested defaults and supports stronger interface tinting', async () => {
    const defaults = await accentSnapshot()
    expect(defaults).not.toBeNull()
    expect(defaults?.accentColor).toBe('#ff93d0')
    // Chromium serializes a color-mix result through the modern color(srgb)
    // syntax on macOS and legacy rgb() on some Linux runners.
    expect(['rgb(30, 32, 30)', 'color(srgb 0.118588 0.124863 0.118745)']).toContain(
      defaults?.bodyBackground,
    )
    expect(defaults?.tintStrength).toBe('subtle')
    expect(defaults?.bodyFontFamily).toContain('Pliant')
    expect(defaults?.textOnAccent).toBe('#444444')
    expect(defaults?.submitBackground).toBe('rgb(255, 147, 208)')
    expect(defaults?.submitColor).toBe('rgb(68, 68, 68)')
    expect(defaults?.submitFontWeight).toBe('600')
    expect(defaults?.submitHeight).toBe(36)
    expect(defaults?.submitPaddingInline).toBe('14px')
    expect(defaults?.submitRadius).toBe('999px')
    expect(defaults?.linkColor).not.toBe('rgb(88, 166, 255)')
    await saveAppScreenshot('accent-default-green.png')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    const accentInput = await $('input[name="uiAccentColor"]')
    await accentInput.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(async () => (await accentInput.getValue()) !== '', {
      timeout: 30_000,
      timeoutMsg: 'expected the saved/default accent to load into Appearance settings',
    })
    expect((await accentInput.getValue()).toLowerCase()).toBe('#ff93d0')
    const tintInput = await $('input[name="uiTintColor"]')
    const tintStrength = await $('input[name="uiTintStrength"]')
    expect((await tintInput.getValue()).toLowerCase()).toBe('#244c25')
    expect(await tintStrength.getValue()).toBe('1')
    const settingsActions = await browser.execute(() => {
      const save = document.querySelector<HTMLElement>('.settings-buttons button[type="submit"]')
      const cancel = document.querySelector<HTMLElement>('.settings-buttons button[type="button"]')
      if (!save || !cancel) return null
      const snapshot = (button: HTMLElement): Record<string, string | number> => ({
        height: button.getBoundingClientRect().height,
        paddingInline: getComputedStyle(button).paddingInline,
        radius: getComputedStyle(button).borderRadius,
        weight: getComputedStyle(button).fontWeight,
      })
      return { save: snapshot(save), cancel: snapshot(cancel) }
    })
    expect(settingsActions).toEqual({
      save: { height: 36, paddingInline: '14px', radius: '999px', weight: '600' },
      cancel: { height: 36, paddingInline: '14px', radius: '999px', weight: '600' },
    })
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
    const headingFont = await browser.execute(
      () => getComputedStyle(document.querySelector('.settings-section.active h3')!).fontFamily,
    )
    expect(headingFont).toContain('Averia Serif Libre')
    await setTintStrength('strong')
    await browser.waitUntil(
      async () =>
        browser.execute(() => document.documentElement.dataset['tintStrength'] === 'strong'),
      { timeout: 10_000, timeoutMsg: 'expected tint strength to preview before saving' },
    )
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
    await browser.waitUntil(
      async () => {
        const snapshot = await accentSnapshot()
        return (
          snapshot?.tintStrength === 'strong' &&
          ['rgb(31, 37, 31)', 'color(srgb 0.121412 0.14651 0.122039)'].includes(
            snapshot.bodyBackground,
          )
        )
      },
      { timeout: 10_000, timeoutMsg: 'expected Strong to apply the selected interface tint' },
    )
    await saveAppScreenshot('accent-strong-green.png')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await $('input[name="uiAccentColor"]').waitForDisplayed({ timeout: 30_000 })
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('input[name="uiAccentColor"]')
      if (!input) return
      input.value = '#7c3aed'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await browser.waitUntil(async () => (await accentSnapshot())?.accentColor === '#7c3aed', {
      timeout: 10_000,
      timeoutMsg: 'expected the accent colour to preview before saving',
    })
    const iconLabels = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.app-icon-label'), (label) =>
        label.textContent?.trim(),
      ),
    )
    expect(iconLabels).toHaveLength(19)
    expect(iconLabels.slice(0, 4)).toEqual(['Rose', 'Pink Lady', 'Mint Leaf', 'Cucumber'])
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

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await $('select[name="theme"]').waitForDisplayed({ timeout: 30_000 })
    await browser.execute(() => {
      const theme = document.querySelector<HTMLSelectElement>('select[name="theme"]')
      const accent = document.querySelector<HTMLInputElement>('input[name="uiAccentColor"]')
      const tint = document.querySelector<HTMLInputElement>('input[name="uiTintColor"]')
      const strength = document.querySelector<HTMLInputElement>('input[name="uiTintStrength"]')
      if (!theme || !accent || !tint || !strength) return
      theme.value = 'light'
      accent.value = '#ff93d0'
      tint.value = '#244c25'
      strength.value = '1'
      accent.dispatchEvent(new Event('change', { bubbles: true }))
      tint.dispatchEvent(new Event('change', { bubbles: true }))
      strength.dispatchEvent(new Event('change', { bubbles: true }))
      theme.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await browser.waitUntil(
      async () => browser.execute(() => document.documentElement.dataset['theme'] === 'light'),
      { timeout: 10_000, timeoutMsg: 'expected theme to preview before saving' },
    )
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.documentElement.dataset['theme'] === 'light' &&
            document.documentElement.dataset['tintStrength'] === 'subtle',
        ),
      { timeout: 10_000, timeoutMsg: 'expected the restrained light theme to apply' },
    )
    const lightDefault = await accentSnapshot()
    expect(lightDefault?.submitBackground).toBe('rgb(255, 147, 208)')
    expect(['rgb(77, 44, 62)', 'color(srgb 0.3 0.172941 0.244706)']).toContain(
      lightDefault?.linkColor,
    )
    await saveAppScreenshot('accent-light-default.png')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await setTintStrength('medium')
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        browser.execute(() => document.documentElement.dataset['tintStrength'] === 'medium'),
      { timeout: 10_000, timeoutMsg: 'expected the Medium light tint to apply' },
    )
    expect((await accentSnapshot())?.submitBackground).toBe('rgb(255, 147, 208)')
    await saveAppScreenshot('accent-light-medium.png')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await setTintStrength('strong')
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        browser.execute(() => document.documentElement.dataset['tintStrength'] === 'strong'),
      { timeout: 10_000, timeoutMsg: 'expected the Strong light tint to apply' },
    )
    await saveAppScreenshot('accent-light-strong.png')
  })
})
