import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedContextWheelFixture,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveFramedElementScreenshot,
  withCaptureFrame,
} from './helpers/screenshot.ts'

/**
 * Wait until the wheel's label stops changing. The pre-send estimate and the
 * run's usage each land a round trip after the DOM first matches, and every
 * landing re-renders the ring, so hovering or capturing on the first match
 * catches whichever one had arrived.
 */
async function waitForSettledWheel(): Promise<void> {
  let previous: string | null = null
  let stable = 0
  await browser.waitUntil(
    async () => {
      const label = await $('.context-wheel').getAttribute('aria-label')
      stable = label === previous ? stable + 1 : 0
      previous = label
      return stable >= 3
    },
    { timeout: 15_000, interval: 200, timeoutMsg: 'the context wheel never settled' },
  )
}

/**
 * Capture the footer as the hover left it. The shell-pinning helpers resize
 * the app, which closes the popover, so the frame goes through the helper
 * that keeps the spec's framing.
 */
async function saveFooterScreenshot(filename: string): Promise<void> {
  await withCaptureFrame(async () => {
    await saveFramedElementScreenshot('.input-footer', filename)
  })
}

describe('context wheel footer seeded', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedContextWheelFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a neutral doughnut and the context and usage hover from the seeded snapshot', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const wheel = await $('.context-wheel').getElement()
    await expect(wheel).toBeDisplayed()
    // The percentage is no longer printed beside the ring: the ring carries the
    // fill, and the figures live in the aria-label and the hover.
    await expect(wheel.$('.context-wheel-label')).not.toExist()
    await expect(wheel).toHaveAttribute('aria-label', /Context 30% used/)

    const fill = await wheel.$('.context-wheel-fill').getElement()
    const dash = await fill.getAttribute('stroke-dasharray')
    expect(dash).toBeTruthy()
    if (!dash) throw new Error('Context wheel stroke dasharray missing')
    const filled = Number.parseFloat(dash.split(' ')[0] ?? '')
    expect(filled).toBeGreaterThan(0)

    await expect($('.footer-usage')).not.toExist()
    await waitForSettledWheel()
    await wheel.moveTo()
    const popover = wheel.$('.context-wheel-popover')
    await expect(popover).toBeDisplayed()
    // An already-run chat keeps the part-by-part estimate on hover, above usage.
    await expect(popover.$('.context-wheel-popover-header')).toHaveText(/^Context · .+ \(\d+%\)$/)
    await expect(popover.$('.footer-usage-popover-header')).toHaveText('Usage · 2.0k tokens')

    await saveFooterScreenshot('context-wheel-seeded-30pct.png')
  })
})

describe('context wheel footer live mock', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // A project on this checkout also starts its new chat from the picker's
    // default branch, which switched the runner's own checkout to `main`.
    seedEmptyProject(seedStableWorkspace(), 'e2e-context-live-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('updates doughnut and tokens live during a mock agent run', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Hold the run mid-turn so "running" is one fixed state rather than
    // whichever usage update the capture raced (three renders on one host).
    const prompt = 'list files please'
    const scenario = await installMockScenario({
      title: 'Context wheel live run',
      turns: [
        {
          user: prompt,
          responses: [{ waitFor: 'wheel-capture', text: 'Here are the files.' }],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await scenario.waitForHold('wheel-capture')

    const wheel = await $('.context-wheel').getElement()
    await expect(wheel).toBeDisplayed({ wait: 30_000 })
    await expect(wheel).toHaveAttribute('aria-label', /context \d+%/i)
    await expect($('.stop-btn')).toBeDisplayed()

    await waitForSettledWheel()
    await wheel.moveTo()
    await expect(wheel.$('.context-wheel-popover .footer-usage-popover-header')).toHaveText(
      /Usage · ~?[\d.]+[kM]? tokens/,
      { wait: 30_000 },
    )

    await saveFooterScreenshot('context-wheel-live-running.png')
    await scenario.release('wheel-capture')
    await scenario.waitForComplete()
  })
})
