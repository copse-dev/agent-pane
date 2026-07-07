import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedComparisonInlineFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for the model comparison harness: a completed two-model comparison
// renders as a card inside .messages-list (like the post-turn review card), with
// two reviewer columns, a judge synthesis, and a cost line. Component tests cover
// the DOM shape; this spec proves it in the real Electron renderer and captures a
// screenshot for visual inspection of the side-by-side layout.
describe('model comparison inline in transcript', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedComparisonInlineFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the comparison card with two columns, a synthesis, and a cost line', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.messages-list [data-comparison-card]').waitForExist({ timeout: 30_000 })

    const layout = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const card = document.querySelector('[data-comparison-card]')
      const columns = card?.querySelectorAll('.comparison-panel-columns .comparison-panel-col')
      return {
        cardInList: !!list && !!card && list.contains(card),
        cardIsLast: !!list && !!card && list.lastElementChild === card,
        columnCount: columns?.length ?? 0,
        hasSynthesis: !!card?.querySelector('.comparison-panel-synthesis'),
        cost: card?.querySelector('.comparison-panel-cost')?.textContent ?? '',
      }
    })

    expect(layout.cardInList).toBe(true)
    expect(layout.cardIsLast).toBe(true)
    // Two reviewers rendered side by side, plus the judge synthesis and cost.
    expect(layout.columnCount).toBe(2)
    expect(layout.hasSynthesis).toBe(true)
    expect(layout.cost).toContain('$')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'comparison-inline-transcript.png'))
  })
})
