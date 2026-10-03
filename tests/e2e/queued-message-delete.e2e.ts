import { $, browser, expect } from '@wdio/globals'
import assert from 'node:assert/strict'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { AA_BODY_TEXT, fillContrast } from './helpers/fill-contrast.ts'
import { switchTheme } from './helpers/theme.ts'

const QUEUED_TEXT = 'Which unit tests should cover the parser refactor?'
const FIRST_PROMPT = 'Suggest a safe refactor for the JSON parser error paths.'
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

    const scenario = await installMockScenario({
      title: 'Refactor JSON parser',
      turns: [
        {
          user: FIRST_PROMPT,
          responses: [
            {
              waitFor: 'parser-refactor',
              text: 'Extract the repeated error conversion into a small helper and leave the parsing branches otherwise unchanged.',
            },
          ],
        },
      ],
    })

    await setComposerValue(FIRST_PROMPT)
    await submitComposer()
    await scenario.waitForHold('parser-refactor')

    await browser.execute((value: string) => {
      const input = document.querySelector('.prompt-input') as HTMLElement | null
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      if (input) input.textContent = value
      btn?.click()
    }, QUEUED_TEXT)

    await $('.conversation-queued .msg-queued').waitForExist({ timeout: 5_000 })
    await expect($('.conversation-queued .message-text')).toHaveText(QUEUED_TEXT)
    await expect($('.queued-delete')).toExist()
    await expect($('.message-queued-model')).toBeDisplayed()
    await expect($('.message-queued-model-label')).toHaveText('Run with')
    const queuedControls = await browser.execute(() => {
      const picker = document.querySelector<HTMLElement>(
        '.message-queued-actions > .message-queued-model',
      )
      const trigger = picker?.querySelector<HTMLElement>('.model-picker-trigger')
      const action = document.querySelector<HTMLElement>('.message-queued-actions .queued-action')
      if (!picker || !trigger || !action) return null
      const pickerRect = picker.getBoundingClientRect()
      const actionRect = action.getBoundingClientRect()
      return {
        sameLine: Math.abs(pickerRect.top - actionRect.top) <= 2,
        pickerBackground: getComputedStyle(trigger).backgroundColor,
        actionBackground: getComputedStyle(action).backgroundColor,
      }
    })
    assert.ok(queuedControls?.sameLine, 'model picker and actions should share one row')
    assert.equal(queuedControls.pickerBackground, 'rgba(0, 0, 0, 0)')
    assert.notEqual(queuedControls.actionBackground, queuedControls.pickerBackground)
    await saveElementScreenshot('.conversation-queued .msg-queued', 'queued-model-picker.png')

    const queuedModelTrigger = $('.message-queued-model .model-picker-trigger')
    await queuedModelTrigger.click()
    await expect($('.message-queued-model .model-picker-menu')).toBeDisplayed()
    const menuIsUnclipped = await browser.execute(() => {
      const menu = document.querySelector<HTMLElement>('.message-queued-model .model-picker-menu')
      if (!menu) return false
      const rect = menu.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      return [rect.top + 2, rect.bottom - 2].every((y) => {
        const hit = document.elementFromPoint(x, y)
        return hit === menu || (hit !== null && menu.contains(hit))
      })
    })
    assert.ok(menuIsUnclipped, 'queued model menu should escape the pinned queue overflow')
    await saveElementScreenshot(
      '.message-queued-model .model-picker-menu',
      'queued-model-picker-menu.png',
    )
    await queuedModelTrigger.click()
    await expect($('.message-queued-model .model-picker-menu')).not.toBeDisplayed()
    await saveAppScreenshot('queued-message-delete-before.png')

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

    // Send now used to flip its label to white on hover while the fill stayed
    // the accent: 1.86:1 in both themes, only while the pointer was on it.
    // The loop leaves the app in light, so put the starting theme back (even on a
    // failed assertion) before the full-app capture below.
    const sendNow = '.conversation-queued .queued-send-now'
    const startTheme = await browser.execute(() => document.documentElement.dataset['theme'])
    try {
      for (const theme of ['dark', 'light'] as const) {
        const current = await browser.execute(() => document.documentElement.dataset['theme'])
        if (current !== theme) await switchTheme(theme)
        await $(sendNow).waitForDisplayed()
        const rest = await fillContrast(sendNow)
        await $(sendNow).moveTo()
        await browser.pause(200)
        const hovered = await fillContrast(sendNow)
        if (!rest || !hovered) throw new Error('Send now chip not found')
        await expect(rest.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
        await expect(hovered.ratio).toBeGreaterThanOrEqual(AA_BODY_TEXT)
        await saveElementScreenshot(ROW_SELECTOR, `queued-actions-row-hover-${theme}.png`)
      }
    } finally {
      const restore = startTheme === 'light' ? 'light' : 'dark'
      const current = await browser.execute(() => document.documentElement.dataset['theme'])
      if (current !== restore) await switchTheme(restore)
    }
    await $('.prompt-input').moveTo()

    await $('.queued-delete').click()

    await browser.waitUntil(
      async () => (await $('.conversation-queued').getProperty('hidden')) === true,
      { timeout: 5_000 },
    )
    await expect($('.message-queued-badge')).not.toExist()
    await expect($('.footer-queue')).toHaveProperty('hidden', true)

    const userMessages = await $$('.messages-list .msg-user .message-text')
    await expect(userMessages).toHaveLength(1)
    await expect(userMessages[0]).toHaveText(FIRST_PROMPT)

    await saveAppScreenshot('queued-message-delete-after.png')
    await scenario.release('parser-refactor')
    await waitForAgentIdle()
    await scenario.assertComplete()
  })
})
