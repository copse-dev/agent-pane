import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedContextWheelFixture } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// While a run is in flight the caller passes `breakdown: null` on purpose — the
// pre-send estimate describes the *next* prompt, so the live snapshot is the
// authoritative source. That used to leave the wheel with nothing at all on
// hover for the whole run. It now falls back to the aggregate it is already
// drawing, which needs no estimate to produce.
describe('context wheel hover while running', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedContextWheelFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the snapshot aggregate on hover mid-run', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()

    // Hold the run open long enough to hover while `status === 'running'`.
    await setComposerValue('Summarise this repo. [[mock:delay_ms 15000]]')
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await $$('.stop-btn')).length > 0, {
      timeout: 15_000,
      timeoutMsg: 'expected the run to start',
    })

    await expect(wheel).toBeDisplayed()
    await browser.pause(500)
    await wheel.moveTo()

    const popover = wheel.$('.context-wheel-popover')
    await expect(popover).toBeDisplayed()
    await expect(popover.$('.context-wheel-popover-header')).toHaveText(/^Context · .+ \(\d+%\)$/)
    // Aggregate only — no per-part rows, because no breakdown exists mid-run.
    await expect(popover.$$('.context-wheel-popover-row')).toBeElementsArrayOfSize(0)

    await saveAppScreenshot('context-wheel-running-hover.png')
  })
})
