import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Issue #2467: the filter panel used to be a `position: absolute` dropdown
// anchored under the "Filter" toggle, painting over every roadmap row below
// it until dismissed — see `tests/e2e/screenshots/tmp-roadmap-filter-repro-before.png`
// captured against the pre-fix code, where all six seeded rows sat entirely
// under the menu. It is now a sticky footer docked below `.roadmap-list`, the
// same bottom-anchored relationship `#input-bar` has to the transcript above
// it, so rows keep their own scroll and stay clickable while it is open.
describe('roadmap filter panel is a sticky footer, not an overlay', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-filter-footer-'))
    knowledgeDir = seedRoadmapNotes(
      'e2e-roadmap-filter-footer',
      Array.from({ length: 6 }, (_, i) => ({
        id: `thread-${String(i)}`,
        title: `Roadmap thread ${String(i + 1)}`,
        body: `Prompt body for thread ${String(i + 1)}.`,
      })),
    )
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-filter-footer', {
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

  it('keeps every row above the footer, fully on screen and clickable', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-text-btn[aria-label="Open roadmap"]').click()
    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 6, {
      timeout: 20_000,
      timeoutMsg: 'expected six seeded roadmap rows',
    })

    await $('.roadmap-filter-toggle').click()
    await $('.roadmap-filter-menu').waitForDisplayed({ timeout: 5_000 })

    const layout = await browser.execute(() => {
      const menu = document.querySelector('.roadmap-filter-menu')?.getBoundingClientRect()
      const list = document.querySelector('.roadmap-list')?.getBoundingClientRect()
      const rows = [...document.querySelectorAll('.roadmap-row')].map((row) =>
        row.getBoundingClientRect(),
      )
      if (!menu || !list) return null
      return {
        menuTop: menu.top,
        menuBottom: menu.bottom,
        listBottom: list.bottom,
        // A footer docked below the list must sit at (or after) its bottom
        // edge, never inside it painting over rows.
        menuStartsAtOrBelowList: menu.top >= list.bottom - 1,
        rowsFullyAboveMenu: rows.every((row) => row.bottom <= menu.top + 1),
        rowCount: rows.length,
      }
    })
    assert.ok(layout, 'roadmap layout must be measurable')
    assert.equal(layout.rowCount, 6)
    assert.ok(
      layout.menuStartsAtOrBelowList,
      `filter footer (top ${String(layout.menuTop)}) must start at or below the list's own box (bottom ${String(layout.listBottom)}), not float over it`,
    )
    assert.ok(
      layout.rowsFullyAboveMenu,
      'every row must sit entirely above the footer — none may be covered by it',
    )

    await saveAppScreenshot('roadmap-filter-sticky-footer.png')

    // A row stays selectable while the footer is shown (issue #2467's actual
    // complaint: the old overlay "made rows hard to click").
    const thirdRow = await $$('.roadmap-row')[2]
    await thirdRow.click()
    await $('.roadmap-row.is-selected').waitForDisplayed({ timeout: 5_000 })
    await expect(thirdRow).toHaveElementClass('is-selected')
    await expect($('.roadmap-form')).toBeDisplayed()
    await expect($('.roadmap-prompt-input')).toHaveValue('Prompt body for thread 3.')
  })
})
