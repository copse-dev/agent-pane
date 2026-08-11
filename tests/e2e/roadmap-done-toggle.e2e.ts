import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Row-level mark-done toggle on the Roadmap pane: the check icon flips a live
// item to `done` without opening the editor. `done` and `archived` are hidden
// by default (only the Status facet can reveal them), and the check icon is
// opacity-hidden until row hover/focus.

// The toggle sits at `opacity: 0` until `.roadmap-row:hover` (roadmap.css:177).
// A single `moveTo()` is not enough: the list re-renders around each status
// change, and a row replaced under a stationary pointer gets no fresh
// `mouseover`, so the icon stays hidden and `waitForDisplayed` times out on a
// row that is perfectly healthy. Re-hover on every poll, re-querying the row so
// a detached handle can't pin us to stale coordinates.
const revealDoneToggle = async () => {
  const toggle = $('.roadmap-done-toggle')
  await browser.waitUntil(
    async () => {
      await $('.roadmap-row').moveTo()
      return await toggle.isDisplayed()
    },
    { timeout: 15_000, timeoutMsg: 'mark-done toggle never revealed on row hover' },
  )
  return toggle
}

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

  it('marks an item done from the list row (hidden by default) and reopens it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-form')).toBeDisplayed()

    await $('.roadmap-prompt-input').setValue('Ship the metrics export command')
    await $('.roadmap-save-btn').click()
    // The create notification can render the row before save() finishes its
    // trailing refresh. Wait for the handler itself to settle so that refresh
    // cannot race and visually overwrite the independent status flip below.
    await $('.roadmap-save-btn').waitForEnabled({ timeout: 20_000 })
    // Background complexity/category stamps may still replace the row later.
    await $('.roadmap-row').waitForExist({ timeout: 20_000 })

    // Saving selects the new item into the editor. Deselect first so the
    // editor is at its empty state — the point of the assertion below is that
    // the toggle flips status *without* selecting the row back into the editor.
    await $('.roadmap-cancel-btn').click()
    await $('.roadmap-empty').waitForDisplayed({ timeout: 10_000 })

    const toggle = await revealDoneToggle()
    assert.equal(await toggle.getAttribute('title'), 'Mark done')
    // Complexity/category stamps can replace the row after hover but before a
    // WebDriver click reaches the cached element. Dispatch on the live control
    // so this still exercises the ordinary DOM click handler without racing a
    // detached handle.
    await browser.execute(() => {
      document.querySelector<HTMLElement>('.roadmap-done-toggle')?.click()
    })

    // `done` is hidden by default, so the row leaves the list on completion
    // rather than staying struck through.
    await browser.waitUntil(async () => (await $('.roadmap-row').isExisting()) === false, {
      timeout: 10_000,
      timeoutMsg: 'done row never disappeared from the list',
    })
    const editorEmpty = await browser.execute(
      () => !document.querySelector<HTMLElement>('.roadmap-empty')!.hidden,
    )
    assert.equal(editorEmpty, true, 'toggle must not open the editor')
    await saveAppScreenshot('roadmap-done-hidden-default.png')

    // Revealing done work is the Status facet's job. It starts unchecked, and
    // checking it brings the row back.
    await $('.roadmap-filter-toggle').click()
    const doneFacet = $('.roadmap-filter-option*=done')
    await doneFacet.waitForDisplayed({ timeout: 10_000 })
    const doneCheckbox = doneFacet.$('input[type="checkbox"]')
    assert.equal(await doneCheckbox.isSelected(), false, 'done starts hidden')
    await doneCheckbox.click()
    await $('.roadmap-row.is-done').waitForDisplayed({ timeout: 10_000 })
    assert.equal(
      await $('.roadmap-status-badge').isExisting(),
      false,
      'done uses strikethrough, not a status chip',
    )
    const doneStyles = await browser.execute(() => {
      const title = document.querySelector<HTMLElement>('.roadmap-row-title')
      const editorEmpty2 = document.querySelector<HTMLElement>('.roadmap-empty')
      if (!title || !editorEmpty2) return null
      return {
        decoration: getComputedStyle(title).textDecorationLine,
        editorStaysEmpty: !editorEmpty2.hidden,
      }
    })
    assert.ok(doneStyles, 'done row styles must exist')
    assert.match(doneStyles.decoration, /line-through/, 'done title is struck through')
    assert.equal(doneStyles.editorStaysEmpty, true, 'revealing a row must not open the editor')
    await saveAppScreenshot('roadmap-done-revealed.png')

    // Unchecking the facet hides it again.
    await doneCheckbox.click()
    await browser.waitUntil(async () => (await $('.roadmap-row').isExisting()) === false, {
      timeout: 10_000,
      timeoutMsg: 'done row never hid again after unchecking',
    })
    await saveAppScreenshot('roadmap-done-filtered.png')

    // Re-enabling the facet brings it back, so the row can be reopened.
    await doneCheckbox.click()
    await $('.roadmap-row.is-done').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-filter-toggle').click()

    // The same control now reopens the item.
    const reopen = await revealDoneToggle()
    assert.equal(await reopen.getAttribute('title'), 'Reopen (set ready)')
    await browser.execute(() => {
      document.querySelector<HTMLElement>('.roadmap-done-toggle')?.click()
    })
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
