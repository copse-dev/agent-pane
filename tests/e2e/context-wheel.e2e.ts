import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedContextWheelFixture, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('context wheel footer seeded', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
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
    await browser.pause(500)
    await wheel.moveTo()
    const popover = wheel.$('.context-wheel-popover')
    await expect(popover).toBeDisplayed()
    // An already-run chat keeps the part-by-part estimate on hover, above usage.
    await expect(popover.$('.context-wheel-popover-header')).toHaveText(/^Context · .+ \(\d+%\)$/)
    await expect(popover.$('.footer-usage-popover-header')).toHaveText('Usage · 2.0k tokens')

    const footer = await $('.input-footer').getElement()
    await footer.saveScreenshot(join(SCREENSHOT_DIR, 'context-wheel-seeded-30pct.png'))
  })
})

describe('context wheel footer live mock', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-context-live-project', {
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

    await setComposerValue('list files please')
    await $('.submit-btn').click()

    const wheel = await $('.context-wheel').getElement()
    await expect(wheel).toBeDisplayed({ wait: 30_000 })
    await expect(wheel).toHaveAttribute('aria-label', /context \d+%/i)

    await browser.pause(500)
    await wheel.moveTo()
    await expect(wheel.$('.context-wheel-popover .footer-usage-popover-header')).toHaveText(
      /Usage · ~?[\d.]+[kM]? tokens/,
      { wait: 30_000 },
    )

    const footer = await $('.input-footer').getElement()
    await footer.saveScreenshot(join(SCREENSHOT_DIR, 'context-wheel-live-running.png'))
  })
})
