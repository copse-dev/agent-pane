import { $, browser } from '@wdio/globals'

/** The tint the Appearance picker offers as the Copse marketing-site theme. */
export const COPSE_TINT_COLOR = '#002e2b'

const TINT_STRENGTHS = ['off', 'subtle', 'medium', 'strong'] as const

export interface AppearanceChoice {
  theme: 'light' | 'dark'
  tintColor: string
  tintStrength: (typeof TINT_STRENGTHS)[number]
}

/**
 * Apply a theme and interface tint through the real Settings → Appearance form
 * and Save, the way a user does, then wait for `<html>` to carry it.
 */
export async function applyAppearanceViaSettings(choice: AppearanceChoice): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('.settings-nav-btn[data-section="appearance"]').click()
  await $('select[name="theme"]').waitForDisplayed({ timeout: 30_000 })
  await browser.execute(
    (next, strengths) => {
      const theme = document.querySelector<HTMLSelectElement>('select[name="theme"]')
      const tint = document.querySelector<HTMLInputElement>('input[name="uiTintColor"]')
      const strength = document.querySelector<HTMLInputElement>('input[name="uiTintStrength"]')
      if (!theme || !tint || !strength) return
      theme.value = next.theme
      tint.value = next.tintColor
      strength.value = String(strengths.indexOf(next.tintStrength))
      // Native colour pickers and sliders commit with `change`.
      for (const control of [tint, strength, theme]) {
        control.dispatchEvent(new Event('input', { bubbles: true }))
        control.dispatchEvent(new Event('change', { bubbles: true }))
      }
    },
    choice,
    [...TINT_STRENGTHS],
  )
  await $('.settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
  await browser.waitUntil(
    async () =>
      browser.execute((next) => {
        const root = document.documentElement
        return (
          root.dataset['theme'] === next.theme &&
          root.dataset['tintStrength'] === next.tintStrength &&
          root.style.getPropertyValue('--tint-hue').trim().toLowerCase() ===
            next.tintColor.toLowerCase()
        )
      }, choice),
    { timeout: 10_000, timeoutMsg: `expected ${JSON.stringify(choice)} to apply` },
  )
}

export interface SurfacePaint {
  /** `--bg-base` resolved to 8-bit sRGB channels. */
  token: number[]
  /** Each selector's computed background, in the same channels (null if absent). */
  surfaces: Record<string, number[] | null>
}

/**
 * Resolve `--bg-base` and each element's computed background to `[r, g, b]`.
 * Chromium serialises a resolved `color-mix()` as `color(srgb …)` on some
 * platforms and `rgb()` on others, so both sides go through a canvas pixel
 * rather than comparing strings.
 */
export async function editorSurfacePaint(selectors: string[]): Promise<SurfacePaint> {
  return browser.execute((targets) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const toRgb = (color: string): number[] => {
      if (!context) return []
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
    }
    const probe = document.createElement('span')
    probe.style.color = 'var(--bg-base)'
    document.body.append(probe)
    const token = toRgb(getComputedStyle(probe).color)
    probe.remove()
    const surfaces: Record<string, number[] | null> = {}
    for (const selector of targets) {
      const element = document.querySelector(selector)
      surfaces[selector] = element ? toRgb(getComputedStyle(element).backgroundColor) : null
    }
    return { token, surfaces }
  }, selectors)
}

/** Largest per-channel difference; 1 absorbs rounding between serialisations. */
export function channelDistance(a: number[] | null, b: number[]): number {
  if (!a || a.length !== 3 || b.length !== 3) return Number.POSITIVE_INFINITY
  return Math.max(...a.map((channel, index) => Math.abs(channel - (b[index] ?? 0))))
}
