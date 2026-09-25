import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterUsageFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// The footer token counter used to toggle an inline in/out/cost label on click.
// It now reads as a plain total and reveals the breakdown on hover, matching the
// context wheel beside it — so this spec pins the hover, not a click.
//
// #2464: the counter used to fold the seeded explore subagents' tokens into the
// headline, and nothing explained why a locally routed subagent showed as free
// next to the paid cloud parent. This spec pins the subagent-excluded headline,
// its explicit boundary from whole-thread cache/cost, and the free-model note.
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

  it('shows the subagent-excluded total, whole-thread accounting, and why a subagent is free', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const counter = await $('.footer-usage')
    await expect(counter).toBeDisplayed()
    // Excluding subagents: 12.1M in + 196.0k out — not the raw 13.5M thread
    // total, which also counts both seeded explore runs.
    await expect(counter).toHaveText('12.3M tokens')

    const popover = await $('.footer-usage-popover')
    await expect(popover).not.toBeDisplayed()

    await browser.pause(500)
    await counter.moveTo()
    await expect(popover).toBeDisplayed()
    await expect(popover.$('.footer-usage-popover-header')).toHaveText('Usage · 12.3M tokens')

    const rows = await popover.getText()
    expect(rows).toMatch(/Excluding subagents/)
    expect(rows).toMatch(/Input\s+12\.1M/)
    expect(rows).toMatch(/Output\s+196\.0k/)
    expect(rows).toMatch(/Whole thread/)
    expect(rows).toMatch(/Cache read\s+11\.7M/)
    expect(rows).toMatch(/Cache write\s+530\.0k/)
    expect(rows).toMatch(/Cost\s+(~\$|<\$)/)
    // The seeded explore runs reported their own usage, already folded out of the
    // subagent-excluded rows above — this row says how much was delegated.
    expect(rows).toMatch(/Subagents\s+2 runs · 1\.2M in \/ 25\.0k out/)
    // Three models in the seeded usage → a per-model section under the divider.
    await expect(popover.$$('.footer-usage-popover-row.is-model')).toBeElementsArrayOfSize(3)
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
