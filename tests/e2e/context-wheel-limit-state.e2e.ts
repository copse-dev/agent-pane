import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedContextWheelFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

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
    seedContextWheelFixture(process.cwd(), 174_600)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('turns the ring red at 95% and says so on hover', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const wheel = await $('.context-wheel').getElement()
    await expect(wheel).toBeDisplayed()
    await expect(wheel).toHaveAttribute('aria-label', /Context 97% used/)

    const fill = await wheel.$('.context-wheel-fill').getElement()
    await expect(fill).toHaveElementClass('is-danger')
    await expect(fill).not.toHaveElementClass('is-warn')

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

    await browser.pause(500)
    await wheel.moveTo()
    const popover = wheel.$('.context-wheel-popover')
    await expect(popover).toBeDisplayed()
    await expect(popover.$('.context-wheel-popover-header')).toHaveText(/^Context · .+ \(\d+%\)$/)
    await expect(popover.$('.footer-usage-popover-header')).toHaveText(/^Usage · /)

    await saveAppScreenshot('context-wheel-danger.png')
  })
})
