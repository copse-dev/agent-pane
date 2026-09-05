import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const QUEUED_TEXT = 'Then add unit tests for the parser.'
const ROW_SELECTOR = '.conversation-queued .message-queued-actions'

describe('queued message delete', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('removes a queued follow-up from the pinned panel', async function () {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-queued-delete', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('Refactor the JSON parser. [[mock:delay_ms 6000]]')
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
      timeout: 10_000,
    })

    await browser.execute((value: string) => {
      const input = document.querySelector('.prompt-input') as HTMLElement | null
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      if (input) input.textContent = value
      btn?.click()
    }, QUEUED_TEXT)

    await $('.conversation-queued .msg-queued').waitForExist({ timeout: 5_000 })
    await expect($('.conversation-queued .message-text')).toHaveText(QUEUED_TEXT)
    await expect($('.queued-delete')).toExist()

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-message-delete-before.png'))

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
    await saveElementScreenshot(ROW_SELECTOR, 'queued-actions-row.png')

    await $('.queued-delete').click()

    await browser.waitUntil(
      async () => (await $('.conversation-queued').getProperty('hidden')) === true,
      { timeout: 5_000 },
    )
    await expect($('.message-queued-badge')).not.toExist()
    await expect($('.footer-queue')).toHaveProperty('hidden', true)

    const userMessages = await $$('.messages-list .msg-user .message-text')
    await expect(userMessages).toHaveLength(1)
    await expect(userMessages[0]).toHaveText('Refactor the JSON parser. [[mock:delay_ms 6000]]')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-message-delete-after.png'))
  })
})
