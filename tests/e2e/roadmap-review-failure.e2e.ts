import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { createFixtureDirectory } from './helpers/fixture-directory.ts'
import { $, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppViewportScreenshot } from './helpers/screenshot.ts'

// A deep resolution check that fails has no verdict to show, so the result box
// carries the reason instead: a short label on the lowercase-styled meta line
// and the explanation below it in body casing. Before this split the whole
// failure — including raw engine JSON from a local model that ran out of
// context — was dumped into the meta line and lowercased.
//
// An item with no stored verdict is stale, so opening it auto-fires the check.
// The unconfigured mock carries no verdict word, and the
// review service rejects it — the same failure surface a context overflow takes.

describe('roadmap resolution check failure', () => {
  let workspaceRoot: string
  let cleanupWorkspace: (() => void) | undefined
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const fixture = createFixtureDirectory('copse-panel-roadmap-review-fail')
    workspaceRoot = fixture.root
    cleanupWorkspace = fixture.cleanup
    knowledgeDir = seedRoadmapNotes('e2e-roadmap-review-fail', [
      {
        id: 'e2e-roadmap-review-fail',
        title: 'Ship the metrics export command',
        body: 'Ship the metrics export command',
        status: 'ready',
      },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-review-fail', {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    cleanupWorkspace?.()
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('reports a failed deep check without dumping it into the status line', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-row').waitForDisplayed({ timeout: 20_000 })
    await $('.roadmap-row').click()

    await $('.roadmap-details > summary').click()
    const errorBox = $('.roadmap-review-result.is-error')
    await errorBox.waitForDisplayed({ timeout: 30_000 })
    assert.equal(
      await errorBox.$('.roadmap-review-result-meta').getText(),
      'resolution check failed',
    )
    const explanation = await errorBox.$('.roadmap-review-result-body').getText()
    assert.ok(explanation.length > 0, 'the failure explains itself in the body')
    assert.doesNotMatch(explanation, /^\s*$/)

    await saveAppViewportScreenshot('roadmap-review-failure.png', async () => {
      // The document editor owns its scrollport; prepare the final capture
      // frame before bringing the actual failure above the fixed action row.
      await errorBox.scrollIntoView({ block: 'center', inline: 'nearest' })
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const error = document.querySelector('.roadmap-review-result.is-error')
            const scroll = document.querySelector('.roadmap-document-scroll')
            const footer = document.querySelector('.roadmap-document-footer')
            if (!error || !scroll || !footer) return false
            const box = error.getBoundingClientRect()
            const viewport = scroll.getBoundingClientRect()
            const actions = footer.getBoundingClientRect()
            return (
              box.height > 0 &&
              box.top >= viewport.top &&
              box.bottom <= Math.min(viewport.bottom, actions.top) &&
              box.left >= viewport.left &&
              box.right <= viewport.right
            )
          }),
        { timeout: 5_000, timeoutMsg: 'expected the full failure explanation above the footer' },
      )
    })
  })
})
