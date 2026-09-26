import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Issue #2438: navigating away from a running (or just-finished, unclosed)
// roadmap review used to drop it silently — `reviewing` was reset to false with
// no way back, even though the run itself kept going/held results. Both items
// here are seeded `done`, so `reviewRoadmapItem` stamps a verdict without a
// model round trip (see roadmap-review.ts) and the bulk run finishes fast and
// deterministically.

describe('roadmap review reattach', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-review-reattach-'))
    knowledgeDir = seedRoadmapNotes('e2e-roadmap-review-reattach', [
      {
        id: 'e2e-roadmap-review-reattach-a',
        title: 'Ship the metrics export command',
        body: 'Ship the metrics export command',
        status: 'done',
      },
      {
        id: 'e2e-roadmap-review-reattach-b',
        title: 'Add a keyboard shortcut to toggle the terminal pane',
        body: 'Add a keyboard shortcut to toggle the terminal pane',
        status: 'done',
      },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-review-reattach', {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('keeps a review reachable through the header button after navigating away', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()

    const reviewBtn = $('.roadmap-review-btn')
    await reviewBtn.waitForDisplayed({ timeout: 10_000 })
    await reviewBtn.click()

    // Deterministic completion signal — both items are `done`, so the bulk run
    // resolves them without a model call.
    const reviewStatus = $('.roadmap-review-status')
    await browser.waitUntil(
      async () => (await reviewStatus.getText()).includes('Review complete'),
      { timeout: 15_000, timeoutMsg: 'bulk review did not complete' },
    )

    // Navigate away without closing the review — the panel used to be
    // discarded here with no way back (issue #2438).
    const importBtn = $('.roadmap-import-btn')
    await importBtn.click()
    await $('.roadmap-import').waitForDisplayed({ timeout: 10_000 })
    await expect($('.roadmap-review')).not.toBeDisplayed()

    await expect(reviewBtn).toHaveElementClass('roadmap-review-btn-live')
    await expect(reviewBtn).toBeEnabled()
    const label = await reviewBtn.getAttribute('aria-label')
    if (!/finished.*2 item/i.test(label ?? '')) {
      throw new Error(`expected a "finished" affordance, got: ${String(label)}`)
    }

    await saveAppScreenshot('roadmap-review-reattach-hidden.png')

    // Clicking the header button brings the panel back with the same results.
    await reviewBtn.click()
    const reviewView = $('.roadmap-review')
    await reviewView.waitForDisplayed({ timeout: 10_000 })
    const rows = await $$('.roadmap-review-row')
    if (rows.length !== 2) {
      throw new Error(`expected 2 recovered review rows, got ${String(rows.length)}`)
    }
    await expect($('.roadmap-review-btn')).not.toHaveElementClass('roadmap-review-btn-live')

    await saveAppScreenshot('roadmap-review-reattach-resumed.png')
  })
})
