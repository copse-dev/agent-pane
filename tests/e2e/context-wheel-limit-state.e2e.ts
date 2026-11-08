import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedContextWheelFixture,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { waitForSettledContextEstimate } from './helpers/context-estimate-settled.ts'

// With the percentage gone from the footer, the ring colour is the only passive
// signal that the window is filling: grey, amber from 80%, red from 95%. The
// amber state is pinned by footer-usage-tooltip.e2e.ts (82%); this spec reaches
// the red one and pins that the colour is the theme's danger token, not a
// hard-coded value.
describe('context wheel near the context limit', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    // 174.6k of the 180k conversation budget: 97%.
    seedContextWheelFixture(seedStableWorkspace(), 174_600)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps the measured ring red and labels the current hover estimate', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const wheel = await $('.context-wheel').getElement()
    await expect(wheel).toBeDisplayed()
    // A settled estimate supplies the hover/accessible figures; the measured
    // snapshot still owns the ring. Wait for both the real reply and its rows.
    await expect(wheel.$('.context-wheel-popover-row')).toExist()
    await waitForSettledContextEstimate()
    await expect(wheel).not.toHaveElementClass('has-breakdown')

    const fill = await wheel.$('.context-wheel-fill').getElement()
    await expect(fill).toHaveElementClass('is-danger')
    await expect(fill).not.toHaveElementClass('is-warn')
    const strokeDasharray = await fill.getAttribute('stroke-dasharray')
    if (strokeDasharray === null) throw new Error('Expected the measured context ring stroke')
    const lengths = strokeDasharray.trim().split(/\s+/).map(Number)
    const [filled, circumference] = lengths
    expect(lengths).toHaveLength(2)
    if (filled === undefined || circumference === undefined) {
      throw new Error('Expected the measured context ring stroke and circumference')
    }
    expect(circumference).toBeGreaterThan(0)
    expect(filled / circumference).toBeCloseTo(0.97, 6)

    const colours = await browser.execute(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--danger)'
      document.body.append(probe)
      const danger = getComputedStyle(probe).color
      probe.remove()
      const ring = document.querySelector('.context-wheel-fill')
      return { danger, stroke: ring ? getComputedStyle(ring).stroke : null }
    })
    expect(colours.stroke).toBe(colours.danger)

    await wheel.moveTo()
    const popover = wheel.$('.context-wheel-popover')
    await expect(popover).toBeDisplayed()
    await expect(popover.$('.context-wheel-popover-header')).toHaveText(/^Context · .+ \(\d+%\)$/)
    await expect(popover.$('.footer-usage-popover-header')).toHaveText(/^Usage · /)
    const header = await popover.$('.context-wheel-popover-header').getText()
    const figures = /^Context · (\d+(?:\.\d+)?k?) \/ (\d+(?:\.\d+)?k?) \((\d+)%\)$/.exec(header)
    const tokens = figures?.[1]
    const budget = figures?.[2]
    const percent = figures?.[3]
    if (tokens === undefined || budget === undefined || percent === undefined) {
      throw new Error(`Expected populated context estimate figures, got ${header}`)
    }
    const ariaLabel = await wheel.getAttribute('aria-label')
    if (ariaLabel === null) throw new Error('Expected the current context accessible label')
    const ariaContext = ariaLabel.split('; ')[0]
    expect(ariaContext).toBe(`Context ${percent}% used, ${tokens} of ${budget} tokens`)
    console.log(
      'context-wheel-limit-state',
      JSON.stringify({
        strokeDasharray,
        measuredFillRatio: filled / circumference,
        ariaContext,
        header,
      }),
    )

    await saveAppScreenshot('context-wheel-danger.png')
  })
})
