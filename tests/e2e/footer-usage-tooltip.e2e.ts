import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterUsageFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// The footer token counter is folded into the context wheel: one ring, one
// hover. The hover shows the context section, then usage, then the delegated
// runs — so this spec pins the combined hover, not a separate counter.
//
// #2464: the counter used to fold the seeded explore subagents' tokens into the
// headline, and nothing explained why a locally routed subagent showed as free
// next to the paid cloud parent. This spec pins the subagent-excluded headline,
// its explicit boundary from whole-thread cache/cost, and the free-model note.
describe('footer context and usage hover', () => {
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

    // No separate counter any more, and no percentage beside the ring.
    await expect($('.footer-usage')).not.toExist()
    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()
    // 82% full: amber, short of the red threshold.
    await expect(wheel.$('.context-wheel-fill')).toHaveElementClass('is-warn')

    const popover = await $('.context-wheel-popover')
    await expect(popover).not.toBeDisplayed()

    await browser.pause(500)
    await wheel.moveTo()
    await expect(popover).toBeDisplayed()
    // The context section comes first; its figures are the next-prompt estimate,
    // which lands asynchronously, so pin its shape rather than its numbers.
    await expect(popover.$('.context-wheel-popover-header')).toHaveText(/^Context · .+ \(\d+%\)$/)
    // Excluding subagents: 12.1M in + 196.0k out — not the raw 13.5M thread
    // total, which also counts both seeded explore runs.
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
    // ...and each run is listed beneath it with its own status, model and tokens.
    await expect(popover.$$('.footer-usage-popover-row.is-run')).toBeElementsArrayOfSize(2)
    expect(rows).toMatch(/Explore · Map the renderer views/)
    expect(rows).toMatch(/lmstudio:qwen · done/)
    expect(rows).toMatch(/claude-haiku-4-5 · done/)
    // Three models in the seeded usage → a per-model section under the divider.
    await expect(popover.$$('.footer-usage-popover-row.is-model')).toBeElementsArrayOfSize(3)
    // The explore subagent ran on a local model — say so, rather than leaving
    // "free" unexplained next to the paid cloud parent.
    expect(rows).toMatch(/Free: local model/)

    await saveAppScreenshot('footer-usage-tooltip.png')
  })

  it('keeps the popover closed when the wheel is clicked', async () => {
    await $('#pane-projects').moveTo({ xOffset: 8, yOffset: 8 })
    const wheel = await $('.context-wheel')
    await wheel.click()
    await $('#pane-projects').moveTo({ xOffset: 8, yOffset: 8 })

    await saveAppScreenshot('footer-usage-tooltip-after-click.png')
    await expect($('.context-wheel-popover')).not.toBeDisplayed()
    expect(
      await browser.execute(() => document.activeElement?.classList.contains('context-wheel')),
    ).toBe(false)

    // Pointer suppression must preserve the keyboard affordance.
    await browser.execute(() => document.querySelector<HTMLElement>('.context-wheel')?.focus())
    await expect($('.context-wheel-popover')).toBeDisplayed()
    await browser.keys('Tab')
    await expect($('.context-wheel-popover')).not.toBeDisplayed()
  })
})
