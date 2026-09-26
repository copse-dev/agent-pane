import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedHeldQueueFixture } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { AA_BODY_TEXT, fillContrast } from './helpers/fill-contrast.ts'
import { switchTheme } from './helpers/theme.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const ROW_SELECTOR = '.conversation-queued .msg-held .message-queued-actions'

// C2 held-state visual eval (decisions 5 & 16). A hook-originated queued message
// that was held (`autoDispatch: false`) renders in the pinned queue panel with a
// distinct "HELD" badge and a "Release" action instead of the plain queued
// "Send now" — the drain loop skips it, so only an explicit human release submits
// it. Drain-skip + release semantics are unit-tested in
// controller/message-queue.test.ts; the DOM shape in views/queued-held.test.ts.
// This captures the rendered state for visual inspection per AGENTS.md.

describe('held hook message in the queue', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('renders a held badge + Release action and captures a screenshot', async function () {
    resetUserData()
    seedHeldQueueFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const heldItem = await $('.conversation-queued .msg-queued.msg-held')
    await heldItem.waitForExist({ timeout: 10_000 })

    await expect($('.msg-held .message-queued-badge')).toHaveText('HELD')
    await expect($('.msg-held .queued-release')).toBeExisting()
    // A held item is released, not "Send now"-ed like a plain queued message.
    await expect($('.msg-held .queued-send-now')).not.toBeExisting()

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-held.png'))

    // The outlined chips carry almost no fill contrast, so the border is the only
    // thing marking where the button ends. Measure it against the surface behind
    // the row: too faint and the eye cannot place the edge, which is what made
    // the filled chip beside them read a size larger. Computed in the real app
    // because the tokens resolve through color-mix and the theme.
    const row = await browser.execute((rowSelector: string) => {
      const el = document.querySelector(rowSelector)
      if (!(el instanceof HTMLElement)) return null
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      // Paint each colour into a canvas so color-mix/oklab resolve to sRGB.
      const toRgb = (colour: string): number[] => {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, 1, 1)
        ctx.fillStyle = colour
        ctx.fillRect(0, 0, 1, 1)
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      const luminance = (rgb: number[]): number => {
        const [r, g, b] = rgb.map((v) => {
          const c = v / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const contrast = (a: number[], b: number[]): number => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
        return (hi + 0.05) / (lo + 0.05)
      }
      // Walk up to the nearest painted ancestor: that is the surface the chip
      // sits on, and so the thing its edge has to stand out from.
      const painted = (from: HTMLElement): number[] | null => {
        for (let node: HTMLElement | null = from; node; node = node.parentElement) {
          const bg = getComputedStyle(node).backgroundColor
          if (bg && !bg.startsWith('rgba(0, 0, 0, 0')) return toRgb(bg)
        }
        return null
      }
      const behind = painted(el)
      if (!behind) return null
      const chips = [...el.querySelectorAll('.queued-action')]
      return {
        heights: chips.map((c) => c.getBoundingClientRect().height),
        outlined: chips
          .filter(
            (c) =>
              !c.classList.contains('queued-send-now') && !c.classList.contains('queued-release'),
          )
          .map((c) => ({
            label: c.textContent,
            edge: Number(contrast(toRgb(getComputedStyle(c).borderTopColor), behind).toFixed(2)),
          })),
      }
    }, ROW_SELECTOR)
    if (!row) throw new Error('queued action row, or the surface behind it, not found')
    // Every chip in the row is the same box — the fix is that they now all draw it.
    await expect(new Set(row.heights).size).toBe(1)
    for (const chip of row.outlined) {
      await expect(chip.edge).toBeGreaterThan(1.6)
    }
    await saveElementScreenshot(ROW_SELECTOR, 'queued-held-actions-row.png')
  })

  it('keeps the HELD badge and Release labels readable in both themes, hovered too', async function () {
    resetUserData()
    seedHeldQueueFixture(process.cwd())
    await browser.reloadSession()
    await $('.conversation-queued .msg-queued.msg-held').waitForExist({ timeout: 30_000 })

    // Both painted white on a fill that is light in dark: the badge on --warning
    // measured 2.31:1 and Release on --accent 2.03:1. The badge takes
    // --text-on-warning now, and Release the Send-now recipe (--accent-fill +
    // --text-on-accent), whose hover lifts the fill instead of flipping the label.
    for (const theme of ['dark', 'light'] as const) {
      const current = await browser.execute(() => document.documentElement.dataset['theme'])
      if (current !== theme) await switchTheme(theme)
      await $('.conversation-queued .msg-held .queued-release').waitForDisplayed()

      const badge = await fillContrast('.conversation-queued .msg-held .message-queued-badge')
      const release = await fillContrast('.conversation-queued .msg-held .queued-release')
      if (!badge || !release) throw new Error('held badge or Release chip not found')
      await expect(badge.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
      await expect(release.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
      await saveElementScreenshot(
        '.conversation-queued .msg-queued.msg-held',
        `queued-held-contrast-${theme}.png`,
      )

      await $('.conversation-queued .msg-held .queued-release').moveTo()
      await browser.pause(200)
      const hovered = await fillContrast('.conversation-queued .msg-held .queued-release')
      if (!hovered) throw new Error('Release chip not found')
      await expect(hovered.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
    }
  })
})
