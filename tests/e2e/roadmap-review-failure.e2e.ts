import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// A deep resolution check that fails has no verdict to show, so the result box
// carries the reason instead: a short label on the lowercase-styled meta line
// and the explanation below it in body casing. Before this split the whole
// failure — including raw engine JSON from a local model that ran out of
// context — was dumped into the meta line and lowercased.
//
// An item with no stored verdict is stale, so opening it auto-fires the check.
// MockLLM answers `Mock response to: …`, which carries no verdict word, and the
// review service rejects it — the same failure surface a context overflow takes.

describe('roadmap resolution check failure', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-review-fail-'))
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
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('reports a failed deep check without dumping it into the status line', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-row').waitForDisplayed({ timeout: 20_000 })
    await $('.roadmap-row').click()

    const errorBox = $('.roadmap-review-result.is-error')
    await errorBox.waitForDisplayed({ timeout: 30_000 })
    assert.equal(
      await errorBox.$('.roadmap-review-result-meta').getText(),
      'resolution check failed',
    )
    const explanation = await errorBox.$('.roadmap-review-result-body').getText()
    assert.ok(explanation.length > 0, 'the failure explains itself in the body')
    assert.doesNotMatch(explanation, /^\s*$/)

    await saveAppScreenshot('roadmap-review-failure.png')
  })
})
