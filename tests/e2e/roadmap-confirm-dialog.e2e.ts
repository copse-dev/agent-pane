import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

// #2497 — the roadmap pane's last native `confirm()` (bulk-apply after a
// backlog review) now routes through the in-app dialog (confirm-dialog.ts).
// Two `done` items make `reviewRoadmapItem` stamp `resolved` from status alone
// (roadmap-review.ts), so the bulk "Archive resolved" affordance appears
// without a small-tasks model call — no MockLLM verdict parsing involved.

describe('roadmap bulk-review confirm dialog', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-confirm-'))
    knowledgeDir = seedRoadmapNotes('e2e-roadmap-confirm', [
      {
        id: 'e2e-roadmap-confirm-a',
        title: 'Fix startup flash',
        body: 'Ensure dark theme applies before first paint.',
        status: 'done',
      },
      {
        id: 'e2e-roadmap-confirm-b',
        title: 'Port e2e specs',
        body: 'Move remaining specs off the legacy runner.',
        status: 'done',
      },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-confirm', {
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

  it('opens an in-app dialog for bulk archive; cancel leaves items untouched, confirm archives them', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()

    const reviewBtn = $('.roadmap-review-btn')
    await reviewBtn.waitForDisplayed({ timeout: 10_000 })
    await reviewBtn.click()

    await browser.waitUntil(async () => (await $$('.roadmap-review-row')).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'expected two judged review rows',
    })
    const badges = await $$('.roadmap-review-badge')
    await expect(badges[0]).toHaveText(expect.stringContaining('review: resolved'))
    await expect(badges[1]).toHaveText(expect.stringContaining('review: resolved'))

    // The bulk affordances start hidden while the review is "in flight"; opening
    // a result row and returning is the same round trip a person makes to read
    // an item before bulk-applying, and it is the render pass that reveals them.
    await $$('.roadmap-review-open')[0].click()
    const reviewBackBtn = $('.roadmap-review-back')
    await reviewBackBtn.waitForDisplayed({ timeout: 10_000 })
    await reviewBackBtn.click()

    const archiveResolvedBtn = $('.roadmap-review-archive-resolved')
    await archiveResolvedBtn.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await archiveResolvedBtn.isEnabled(), true, 'bulk archive is enabled')

    // Cancelling the in-app dialog must not touch either item.
    await archiveResolvedBtn.click()
    const dialog = $('#confirm-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(await dialog.$('.confirm-dialog-message')).toHaveText(
      'Archive 2 item(s) judged resolved or likely?',
    )
    await expect(await dialog.$('.confirm-dialog-detail')).toHaveText(
      'Archives each one; you can restore any of them later.',
    )
    await expect(await dialog.$('.confirm-dialog-cancel')).toHaveText('Cancel')
    await expect(await dialog.$('.confirm-dialog-confirm')).toHaveText('Archive')

    await saveElementScreenshot('#confirm-dialog', 'roadmap-confirm-dialog.png')

    await dialog.$('.confirm-dialog-cancel').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    assert.equal(
      (await $$('.roadmap-review-row.is-applied')).length,
      0,
      'cancel leaves both items unchanged',
    )
    await expect(archiveResolvedBtn).toBeDisplayed()
    assert.equal(await archiveResolvedBtn.isEnabled(), true, 'bulk archive stays available')

    // Confirming applies the bulk archive to both items.
    await archiveResolvedBtn.click()
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await dialog.$('.confirm-dialog-confirm').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    await expect($('.roadmap-review-status')).toHaveText(
      expect.stringContaining('Updated 2 item(s).'),
    )
    await browser.waitUntil(async () => (await $$('.roadmap-review-row.is-applied')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'expected both rows to show as applied',
    })
    const appliedBadges = await $$('.roadmap-review-applied-badge')
    await expect(appliedBadges[0]).toHaveText('status: archived', { ignoreCase: true })
    await expect(appliedBadges[1]).toHaveText('status: archived', { ignoreCase: true })
    // Nothing left to bulk-act on: the affordance disappears.
    await expect(archiveResolvedBtn).not.toBeDisplayed()
  })
})
