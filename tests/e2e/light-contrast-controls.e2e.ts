import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

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

/** Runs in the browser: WCAG contrast between an element's label and its fill. */
function controlContrast(selector: string): number | null {
  const channels = (value: string): number[] =>
    (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const luminance = (rgb: number[]): number => {
    const linear = rgb.map((channel) => {
      const scaled = channel > 1 ? channel / 255 : channel
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }
  const contrast = (a: string, b: string): number => {
    const [x, y] = [luminance(channels(a)), luminance(channels(b))]
    const [high, low] = x! > y! ? [x!, y!] : [y!, x!]
    return (high + 0.05) / (low + 0.05)
  }
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return null
  const style = getComputedStyle(el)
  return contrast(style.color, style.backgroundColor)
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
    await $('.roadmap-save-btn').waitForDisplayed({ timeout: 10_000 })

    async function measureAndCapture(theme: 'light' | 'dark') {
      await browser.execute((mode) => {
        document.documentElement.dataset['theme'] = mode
      }, theme)
      await browser.pause(100)
      await saveElementScreenshot(
        '.titlebar-btn[aria-label="Open changes"] .titlebar-btn-badge',
        `light-contrast-changes-badge-${theme}.png`,
      )
      await saveElementScreenshot('.roadmap-save-btn', `light-contrast-save-button-${theme}.png`)
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

    // Hand the page back in the theme the project was seeded with.
    await browser.execute(() => {
      document.documentElement.dataset['theme'] = 'light'
    })

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
