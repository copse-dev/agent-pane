import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Row-level mark-done toggle on the Roadmap pane: the check icon flips a live
// item to `done` without opening the editor. The icon is opacity-hidden until
// row hover/focus. Since #1418 every status is enabled by default, so a done
// row stays listed (struck through, refresh icon to reopen) and hiding it is
// the Status facet's job rather than a dedicated toolbar toggle.
describe('roadmap done toggle', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-done-'))
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-done', {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('marks an item done from the list row and reopens it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-form')).toBeDisplayed()

    await $('.roadmap-prompt-input').setValue('Ship the metrics export command')
    await $('.roadmap-save-btn').click()
    // The note persists immediately; the row appears without waiting on the
    // background complexity stamp (which needs a model that may be absent here).
    await $('.roadmap-row').waitForExist({ timeout: 20_000 })

    // Saving selects the new item into the editor. Deselect first so the
    // editor is at its empty state — the point of the assertion below is that
    // the toggle flips status *without* selecting the row back into the editor.
    await $('.roadmap-cancel-btn').click()
    await $('.roadmap-empty').waitForDisplayed({ timeout: 10_000 })

    // Hover reveals the mark-done icon (opacity 0 at rest).
    const row = $('.roadmap-row')
    await row.moveTo()
    const toggle = $('.roadmap-done-toggle')
    await toggle.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await toggle.getAttribute('title'), 'Mark done')
    await toggle.click()
    // Every status is enabled by default, so the row stays listed once done.
    await browser.waitUntil(async () => (await $('.roadmap-row.is-done').isExisting()) === true, {
      timeout: 10_000,
      timeoutMsg: 'done row class never appeared',
    })
    assert.equal(
      await $('.roadmap-status-badge').isExisting(),
      false,
      'done uses strikethrough, not a status chip',
    )

    const doneStyles = await browser.execute(() => {
      const title = document.querySelector<HTMLElement>('.roadmap-row-title')
      const editorEmpty = document.querySelector<HTMLElement>('.roadmap-empty')
      if (!title || !editorEmpty) return null
      return {
        decoration: getComputedStyle(title).textDecorationLine,
        editorStaysEmpty: !editorEmpty.hidden,
      }
    })
    assert.ok(doneStyles, 'done row styles must exist')
    assert.match(doneStyles.decoration, /line-through/, 'done title is struck through')
    assert.equal(doneStyles.editorStaysEmpty, true, 'toggle must not open the editor')
    await saveAppScreenshot('roadmap-done-toggle.png')

    // Hiding done work is the Status facet's job now. Unchecking `done` empties
    // the list, and the empty state says a filter — not an empty roadmap — is
    // why nothing is showing.
    await $('.roadmap-filter-toggle').click()
    const doneFacet = $('.roadmap-filter-option*=done')
    await doneFacet.waitForDisplayed({ timeout: 10_000 })
    const doneCheckbox = doneFacet.$('input[type="checkbox"]')
    assert.equal(await doneCheckbox.isSelected(), true, 'done starts enabled')
    await doneCheckbox.click()
    await $('.roadmap-list-empty').waitForDisplayed({ timeout: 10_000 })
    assert.match(await $('.roadmap-list-empty').getText(), /match your filter/i)
    assert.equal((await $$('.roadmap-row')).length, 0)
    await saveAppScreenshot('roadmap-done-filtered.png')

    // Re-enabling the facet brings it back, so the row can be reopened.
    await doneCheckbox.click()
    await $('.roadmap-row.is-done').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-filter-toggle').click()

    // The same control now reopens the item.
    await $('.roadmap-row').moveTo()
    assert.equal(await $('.roadmap-done-toggle').getAttribute('title'), 'Reopen (set ready)')
    await $('.roadmap-done-toggle').click()
    await browser.waitUntil(
      async () =>
        (await $('.roadmap-row').isExisting()) === true &&
        (await $('.roadmap-row.is-done').isExisting()) === false,
      { timeout: 10_000, timeoutMsg: 'row never returned to ready (no is-done)' },
    )
    assert.equal(
      await $('.roadmap-status-badge').isExisting(),
      false,
      'ready stays silent after reopen',
    )
  })
})
