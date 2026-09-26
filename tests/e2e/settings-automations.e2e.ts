import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { PNG } from 'pngjs'
import { AUTOMATIONS_PLUGIN_ID } from '../../packages/agent/src/plugins/automations-plugin.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveElementScreenshot,
  waitForSettledLayout,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { assertKitButtonRow, measureKitButtonRow } from './helpers/kit-buttons.ts'

const PROJECT_ID = 'e2e-settings-automations'
const SCHEDULE_ID = 'schedule-morning-review'
/** WCAG 2.2 AA for body text; the compact row labels are small text. */
const AA_BODY_TEXT = 4.5

/**
 * Runs in the browser: the hovered button's label and fill as painted. The
 * computed colours go through a 1×1 canvas so color-mix/oklab resolve to sRGB,
 * and every background from the root down is painted in order, so a
 * translucent hover fill is composited over whatever sits behind it.
 */
function hoveredLabelContrast(selector: string): {
  hovered: boolean
  color: string
  background: string
  contrast: number
  labelIsTextOnAccent: boolean
} | null {
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const style = getComputedStyle(el)
  const layers: string[] = []
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor)
  }
  // Chromium's default canvas is white; the app's root background paints over it.
  const paint = (colours: string[]): number[] => {
    ctx.clearRect(0, 0, 1, 1)
    for (const colour of ['#fff', ...colours]) {
      ctx.fillStyle = colour
      ctx.fillRect(0, 0, 1, 1)
    }
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }
  const luminance = (rgb: number[]): number => {
    const [r = 0, g = 0, b = 0] = rgb.map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const fill = paint(layers)
  const label = paint([...layers, style.color])
  const onAccent = paint([
    ...layers,
    getComputedStyle(document.documentElement).getPropertyValue('--text-on-accent').trim(),
  ])
  const [hi = 0, lo = 0] = [luminance(label), luminance(fill)].sort((x, y) => y - x)
  return {
    hovered: el.matches(':hover'),
    color: style.color,
    background: style.backgroundColor,
    contrast: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)),
    labelIsTextOnAccent: label.every((channel, i) => channel === onAccent[i]),
  }
}

/**
 * Element capture that keeps `:hover`. The WebDriver element-screenshot command
 * drops the pointer's hover state in this Chromium (the hovered fill is missing
 * from the PNG and `:hover` no longer matches afterwards), so crop the element
 * out of a viewport capture instead, as `canvas-background-parity.e2e.ts` does.
 */
async function saveHoveredElementScreenshot(selector: string, filename: string): Promise<void> {
  await prepareE2eScreenshot()
  await waitForSettledLayout(selector)
  const crop = await browser.execute((sel: string) => {
    const rect = document.querySelector(sel)?.getBoundingClientRect()
    if (!rect) return null
    const scale = window.devicePixelRatio
    const left = Math.floor(rect.left * scale)
    const top = Math.floor(rect.top * scale)
    return {
      left,
      top,
      width: Math.ceil(rect.right * scale) - left,
      height: Math.ceil(rect.bottom * scale) - top,
    }
  }, selector)
  assert.ok(crop && crop.width > 0 && crop.height > 0, `${selector} has no capture area`)
  const viewport = PNG.sync.read(Buffer.from(await browser.takeScreenshot(), 'base64'))
  assert.ok(
    crop.left >= 0 &&
      crop.top >= 0 &&
      crop.left + crop.width <= viewport.width &&
      crop.top + crop.height <= viewport.height,
    `${selector} extends outside the viewport`,
  )
  const image = new PNG({ width: crop.width, height: crop.height })
  PNG.bitblt(viewport, image, crop.left, crop.top, crop.width, crop.height, 0, 0)
  writeFileSync(join(E2E_SCREENSHOT_DIR, filename), PNG.sync.write(image))
}

describe('settings automations plugin', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    // The automations plugin has no legacy opt-in, so production seeds it off
    // once. Mark that migration complete and seed the explicit enabled state +
    // plugin storage for this visual fixture.
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      pluginDisabled: [],
      // electron-store resolves dotted keys through nested config objects.
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'Weekday project review',
                cron: '0 9 * * 1-5',
                prompt: 'Review open work and prepare a concise project status update.',
                model: 'claude-sonnet-4-6',
                // Keep the visual fixture deterministic: the production scheduler is
                // live during e2e, so an armed weekday schedule could create a task
                // when CI happens to run at 09:00 local time.
                enabled: false,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders project scope, a readable schedule, model, and the permission boundary', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const row = dialog.$(`.plugin-row[data-plugin-id="${AUTOMATIONS_PLUGIN_ID}"]`)
    await row.waitForExist({ timeout: 15_000 })
    await row.scrollIntoView({ block: 'center' })
    assert.equal(await row.getAttribute('data-enabled'), 'true')
    await expect(row.$('.plugin-chip=UI × 2')).toBeDisplayed()

    // The plugin's detail panel sits inside its closed "Plugin settings" fold.
    await row.$('.plugin-settings-summary').click()
    const detail = row.$('.automation-plugin-settings')
    await expect(detail).toBeDisplayed()
    assert.match(await detail.getText(), /Project: workspace · local time/)
    assert.match(await detail.getText(), /Weekday project review/)
    assert.match(await detail.getText(), /Every weekday at 09:00/)
    assert.doesNotMatch(await detail.getText(), /0 9 \* \* 1-5/)
    assert.match(await detail.getText(), /Claude Sonnet 4\.6/)
    assert.match(await detail.getText(), /Each run starts a fresh isolated task/i)
    assert.match(await detail.getText(), /One live worktree is the safe default/i)
    assert.match(await detail.getText(), /1 live worktree max/i)
    assert.match(await detail.getText(), /Normal tool permission prompts still apply/i)
    await expect(detail.$('.automation-run-btn')).toBeEnabled()
    // Row actions are compact kit buttons (#3065): Edit / Run now secondary,
    // Delete the kit danger, --spacing-md apart.
    const rowActions = assertKitButtonRow(
      await measureKitButtonRow('.automation-row-actions'),
      'automation row',
      { compact: true, minButtons: 3 },
    )
    assert.deepEqual(
      rowActions.buttons.map((button) =>
        button.classes.find((c) => ['ui-btn-secondary', 'ui-btn-danger'].includes(c)),
      ),
      ['ui-btn-secondary', 'ui-btn-secondary', 'ui-btn-danger'],
    )
    await saveElementScreenshot('.automation-plugin-settings', 'settings-automations.png')

    // Hovered "Run now" keeps a readable label. The bespoke button it replaced
    // was filled with dark --text-on-accent text, and the shared row hover
    // swapped only the fill to dark --bg-hover, leaving the label unreadable.
    const runNow = detail.$('.automation-run-btn')
    await runNow.scrollIntoView({ block: 'center' })
    await runNow.moveTo()
    await browser.waitUntil(
      async () => {
        const probe = await browser.execute(hoveredLabelContrast, '.automation-run-btn')
        return probe?.hovered === true && probe.background !== 'rgba(0, 0, 0, 0)'
      },
      { timeout: 5_000, timeoutMsg: 'Run now never took its hover fill' },
    )
    const hovered = await browser.execute(hoveredLabelContrast, '.automation-run-btn')
    assert.ok(hovered, 'Run now button not found')
    assert.ok(
      hovered.contrast >= AA_BODY_TEXT,
      `hovered Run now label ${hovered.color} on ${hovered.background} is ${String(hovered.contrast)}:1, below ${String(AA_BODY_TEXT)}:1`,
    )
    assert.equal(hovered.labelIsTextOnAccent, false, 'hovered Run now label is --text-on-accent')
    await saveHoveredElementScreenshot(
      '.automation-row-actions',
      'settings-automations-run-now-hover.png',
    )
    // The capture must show the hover state, not a frame after it dropped.
    const afterCapture = await browser.execute(hoveredLabelContrast, '.automation-run-btn')
    assert.ok(afterCapture, 'Run now button not found after the capture')
    assert.equal(afterCapture.hovered, true, 'Run now lost hover during the capture')
    assert.equal(afterCapture.background, hovered.background)

    // Capture the editor separately so the settings dialog's sticky global
    // footer cannot cover a tall schedule form in the reference image.
    await detail.$('.automation-add-btn').click()
    await expect(detail.$('.automation-form')).toBeDisplayed()
    await expect(detail.$('.automation-form .model-picker-field')).toBeDisplayed()
    await expect(detail.$('.automation-cron-input')).not.toExist()
    await expect(detail.$('.automation-repeat-select')).toHaveValue('weekdays')
    await expect(detail.$('.automation-time-input')).toHaveValue('09:00')
    await expect(detail.$('.automation-schedule-summary')).toHaveText(
      'Every weekday at 09:00 · local time',
    )
    await expect(detail.$('.automation-worktree-limit-select')).toHaveValue('1')
    await expect(dialog.$('.settings-buttons')).not.toBeDisplayed()
    await detail.$('.automation-form').scrollIntoView({ block: 'center' })
    // Save schedule is the form's kit primary; Cancel the kit secondary.
    const formActions = assertKitButtonRow(
      await measureKitButtonRow('.automation-form-actions'),
      'automation form',
      { compact: false, minButtons: 2 },
    )
    assert.ok(formActions.buttons[0]?.classes.includes('ui-btn-primary'), 'Save is the primary')
    assert.ok(formActions.buttons[1]?.classes.includes('ui-btn-secondary'), 'Cancel is secondary')
    await saveElementScreenshot('.automation-form', 'settings-automation-form.png')
    await detail.$('.automation-cancel-btn').click()
    await expect(dialog.$('.settings-buttons')).toBeDisplayed()
  })
})
