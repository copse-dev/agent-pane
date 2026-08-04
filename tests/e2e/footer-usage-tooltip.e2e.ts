import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterUsageFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// The footer token counter used to toggle an inline in/out/cost label on click.
// It now reads as a plain total and reveals the breakdown on hover, matching the
// context wheel beside it — so this spec pins the hover, not a click.
describe('footer token usage tooltip', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedFooterUsageFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows in/out, cache and cost on hover over the token counter', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const counter = await $('.footer-usage')
    await expect(counter).toBeDisplayed()
    await expect(counter).toHaveText('13.1M tokens')

    const popover = await $('.footer-usage-popover')
    await expect(popover).not.toBeDisplayed()

    await browser.pause(500)
    await counter.moveTo()
    await expect(popover).toBeDisplayed()
    await expect(popover.$('.footer-usage-popover-header')).toHaveText('Usage · 13.1M tokens')

    const rows = await popover.getText()
    expect(rows).toMatch(/Input\s+12\.9M/)
    expect(rows).toMatch(/Output\s+211\.0k/)
    expect(rows).toMatch(/Cache read\s+11\.4M/)
    expect(rows).toMatch(/Cache write\s+480\.0k/)
    expect(rows).toMatch(/Cost\s+(~\$|<\$)/)
    // The seeded explore run reported its own usage, already counted in the
    // totals above — the row says how much of them was delegated.
    expect(rows).toMatch(/Subagents\s+1 run · 800\.0k in \/ 15\.0k out/)
    // Two models in the seeded usage → a per-model section under the divider.
    await expect(popover.$$('.footer-usage-popover-row.is-model')).toBeElementsArrayOfSize(2)

    await saveAppScreenshot('footer-usage-tooltip.png')
  })

  it('keeps the counter label unchanged when clicked', async () => {
    const counter = await $('.footer-usage')
    await counter.click()

    await expect(counter).toHaveText('13.1M tokens')
  })
})
