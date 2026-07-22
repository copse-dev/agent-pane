import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Row-level mark-done toggle on the Roadmap pane: ✓ flips a live item to
// `done` without opening the editor. Done rows are filtered out by default;
// the header "done" toggle reveals them (struck-through title, ↺ reopen).
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

    const toggle = $('.roadmap-done-toggle')
    await toggle.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await toggle.getAttribute('title'), 'Mark done')
    await toggle.click()
    // Done items leave the list until the show-done filter is on.
    await $('.roadmap-list-empty').waitForDisplayed({ timeout: 10_000 })
    assert.match(await $('.roadmap-list-empty').getText(), /Turn on "done"/i)
    await saveAppScreenshot('roadmap-done-filtered.png')

    const showDone = $('.roadmap-show-done-btn')
    await showDone.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await showDone.getAttribute('aria-pressed'), 'false')
    await showDone.click()
    assert.equal(await showDone.getAttribute('aria-pressed'), 'true')
    await browser.waitUntil(
      async () => (await $('.roadmap-status-badge').getText()).toLowerCase() === 'done',
      { timeout: 10_000, timeoutMsg: 'status badge never flipped to done' },
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

    // The same control now reopens the item.
    assert.equal(await $('.roadmap-done-toggle').getAttribute('title'), 'Reopen (set ready)')
    await $('.roadmap-done-toggle').click()
    await browser.waitUntil(
      async () => (await $('.roadmap-status-badge').getText()).toLowerCase() === 'ready',
      { timeout: 10_000, timeoutMsg: 'status badge never flipped back to ready' },
    )
  })
})
