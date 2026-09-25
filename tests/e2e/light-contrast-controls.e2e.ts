import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

// Real-app visual + numeric evidence for issue #2488: the roadmap Save button
// and the titlebar Changes-count badge painting `--text-on-accent` (a dark
// grey) onto light's darkened `--accent` instead of the raw `--accent-fill`,
// which measured 1.24:1. Both controls now declare `--accent-fill` directly
// (`memories.css` `.memories-btn-primary`, `titlebar.css` `.titlebar-btn-badge`)
// and are pinned at the stylesheet level by
// `src/renderer/styles/light-contrast.test.ts`. This spec is the top of the
// pyramid: it proves the *rendered* cascade on the real controls — the real
// roadmap Save button reached through the real "New" flow, and the real
// titlebar badge element — in both themes, rather than a synthetic element or
// a hand-computed hex.
//
// The accent (`#20FD85`, bright green) matches the "dark-green fill" the
// report described: light derives `--accent` as 30% of the accent mixed with
// black, so a bright accent makes the wrong derivation obviously too dark
// rather than marginally so.
const PROJECT_ID = 'e2e-light-contrast-controls'
const ACCENT = '#20FD85'
/** WCAG 2.2 AA for body text; both controls carry small/bold label text. */
const AA_BODY_TEXT = 4.5

/**
 * Runs in the browser: WCAG contrast between an element's label and its fill.
 * Computed colours arrive as `rgb()`/`rgba()` (0–255 channels) or
 * `color(srgb …)` (0–1 channels); a translucent fill is composited over the
 * nearest ancestor backdrop, and a translucent label over the fill.
 */
function controlContrast(selector: string): number | null {
  type Rgba = [number, number, number, number]
  const parse = (value: string): Rgba | null => {
    const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/.exec(
      value.trim(),
    )
    const rgb =
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
        value.trim(),
      )
    const match = srgb ?? rgb
    if (!match) return null
    const scale = srgb ? 1 : 255
    const alpha =
      match[4] === undefined
        ? 1
        : match[4].endsWith('%')
          ? Number.parseFloat(match[4]) / 100
          : Number(match[4])
    return [Number(match[1]) / scale, Number(match[2]) / scale, Number(match[3]) / scale, alpha]
  }
  const over = (top: Rgba, bottom: Rgba): Rgba => [
    top[0] * top[3] + bottom[0] * (1 - top[3]),
    top[1] * top[3] + bottom[1] * (1 - top[3]),
    top[2] * top[3] + bottom[2] * (1 - top[3]),
    1,
  ]
  const luminance = (rgb: Rgba): number => {
    const linear = (channel: number): number =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
  }
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return null
  const style = getComputedStyle(el)
  const label = parse(style.color)
  let fill = parse(style.backgroundColor)
  if (!label || !fill) return null
  // Fill the rest of the way from the ancestors, innermost first.
  for (let node = el.parentElement; node && fill[3] < 1; node = node.parentElement) {
    const backdrop = parse(getComputedStyle(node).backgroundColor)
    if (backdrop && backdrop[3] > 0) fill = over(fill, backdrop)
  }
  if (fill[3] < 1) fill = over(fill, [1, 1, 1, 1])
  const [x, y] = [luminance(over(label, fill)), luminance(fill)]
  const [high, low] = x > y ? [x, y] : [y, x]
  return (high + 0.05) / (low + 0.05)
}

/** Change theme through the same persisted settings surface a user uses. */
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
  await $('.roadmap-save-btn').waitForDisplayed({ timeout: 10_000 })
}

describe('light-contrast controls: roadmap Save button + Changes badge (issue #2488)', () => {
  let workspaceRoot: string

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-light-contrast-controls-'))
    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
      theme: 'light',
      uiAccentColor: ACCENT,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('clears AA on the real Changes badge and roadmap Save button in light and dark', async () => {
    const scenario = await prepareMockToolTurn(
      'Prepare a proposed file for contrast testing.',
      {
        name: 'write_file',
        args: { path: 'contrast-proof.ts', content: 'export const contrastProof = true\n' },
      },
      'The proposed contrast proof is ready.',
    )
    await $('.submit-btn').click()
    await expectAssistantReply('The proposed contrast proof is ready.')
    await scenario.assertComplete()

    const changesBadge = $('.titlebar-btn[aria-label="Open changes"] .titlebar-btn-badge')
    await changesBadge.waitForDisplayed({ timeout: 30_000 })
    assert.equal(
      await changesBadge.getText(),
      '1',
      'the real proposed-diff count should be visible',
    )

    const roadmapButton = $('.titlebar-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    const saveButton = $('.roadmap-save-btn')
    await saveButton.waitForDisplayed({ timeout: 10_000 })
    assert.equal(
      await saveButton.getText(),
      'Save',
      'the real roadmap Save label should be visible',
    )

    async function measureAndCapture(theme: 'light' | 'dark') {
      const currentTheme = await browser.execute(
        () => document.documentElement.dataset['theme'] ?? null,
      )
      if (currentTheme !== theme) await switchTheme(theme)
      await saveElementScreenshot(
        '.titlebar-btn[aria-label="Open changes"] .titlebar-btn-badge',
        `light-contrast-changes-badge-${theme}.png`,
      )
      // Keep the Save evidence inside the full app frame. Switching through
      // persisted settings gives Chromium a stable render before capture;
      // directly mutating data-theme has intermittently dropped painted glyphs.
      await saveAppScreenshot(`light-contrast-save-button-${theme}.png`)
      const badge = await browser.execute(
        controlContrast,
        '.titlebar-btn[aria-label="Open changes"] .titlebar-btn-badge',
      )
      const saveBtn = await browser.execute(controlContrast, '.roadmap-save-btn')
      assert.ok(badge !== null, `Changes badge must exist in ${theme}`)
      assert.ok(saveBtn !== null, `roadmap Save button must exist in ${theme}`)
      return { badge, saveBtn }
    }

    const light = await measureAndCapture('light')
    const dark = await measureAndCapture('dark')

    for (const [theme, measured] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      assert.ok(
        measured.badge! >= AA_BODY_TEXT,
        `Changes badge falls below ${String(AA_BODY_TEXT)}:1 in ${theme}: ${measured.badge!.toFixed(2)}:1`,
      )
      assert.ok(
        measured.saveBtn! >= AA_BODY_TEXT,
        `roadmap Save button falls below ${String(AA_BODY_TEXT)}:1 in ${theme}: ${measured.saveBtn!.toFixed(2)}:1`,
      )
    }
  })
})
