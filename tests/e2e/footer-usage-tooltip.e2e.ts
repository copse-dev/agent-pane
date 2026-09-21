import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterUsageFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// The footer token counter used to toggle an inline in/out/cost label on click.
// It now reads as a plain total and reveals the breakdown on hover, matching the
// context wheel beside it — so this spec pins the hover, not a click.
//
// #2464: the counter used to fold the seeded explore subagent's tokens into the
// headline (parent 12.1M/196.0k + subagent 800.0k/15.0k read as one 13.1M
// total), and nothing explained why the subagent — routed to a local model —
// showed as free next to the paid cloud parent. This spec now pins the
// parent-only headline, the "This conversation" / "Subagents" split, and the
// free-model explanation.
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

  it('shows the parent-only total, the delegated split, cache/cost, and why the subagent is free', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const counter = await $('.footer-usage')
    await expect(counter).toBeDisplayed()
    // Parent-only: 12.1M in + 196.0k out — not the raw 13.1M thread total,
    // which also counts the seeded explore subagent's 800.0k in / 15.0k out.
    await expect(counter).toHaveText('12.3M tokens')

    const popover = await $('.footer-usage-popover')
    await expect(popover).not.toBeDisplayed()

    await browser.pause(500)
    await counter.moveTo()
    await expect(popover).toBeDisplayed()
    await expect(popover.$('.footer-usage-popover-header')).toHaveText('Usage · 12.3M tokens')

    const rows = await popover.getText()
    expect(rows).toMatch(/This conversation/)
    expect(rows).toMatch(/Input\s+12\.1M/)
    expect(rows).toMatch(/Output\s+196\.0k/)
    expect(rows).toMatch(/Cache read\s+11\.4M/)
    expect(rows).toMatch(/Cache write\s+480\.0k/)
    expect(rows).toMatch(/Cost\s+(~\$|<\$)/)
    // The seeded explore run reported its own usage, already folded out of the
    // parent rows above — this row says how much was delegated.
    expect(rows).toMatch(/Subagents\s+1 run · 800\.0k in \/ 15\.0k out/)
    // Two models in the seeded usage → a per-model section under the divider.
    await expect(popover.$$('.footer-usage-popover-row.is-model')).toBeElementsArrayOfSize(2)
    // The explore subagent ran on a local model — say so, rather than leaving
    // "free" unexplained next to the paid cloud parent.
    expect(rows).toMatch(/Free: local model/)

    await saveAppScreenshot('footer-usage-tooltip.png')
  })

  it('keeps the counter label unchanged when clicked', async () => {
    const counter = await $('.footer-usage')
    await counter.click()

    await expect(counter).toHaveText('12.3M tokens')
  })
})
