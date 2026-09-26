import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Regression coverage for #2518: the category accordion's chevron must sit on
// the same visual centerline as its label, and toggling a group must not move
// the list's scroll position. Both bugs need a list that actually overflows
// its pane, so this seeds far more rows than the other roadmap specs.
describe('roadmap category accordion (alignment + scroll)', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-accordion-'))
    const bugItems = Array.from({ length: 60 }, (_, i) => ({
      id: `e2e-accordion-bug-${String(i)}`,
      title: `Bug item ${String(i)}`,
      body: `Fix bug number ${String(i)}.`,
      category: 'bug',
    }))
    const featureItems = Array.from({ length: 15 }, (_, i) => ({
      id: `e2e-accordion-feature-${String(i)}`,
      title: `Feature item ${String(i)}`,
      body: `Ship feature number ${String(i)}.`,
      category: 'feature',
    }))
    knowledgeDir = seedRoadmapNotes('e2e-roadmap-accordion', [...bugItems, ...featureItems])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-accordion', {
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

  // The nav button is a *toggle* (toggleRightPanelWithWorkspace) — clicking it
  // while the roadmap pane is already open closes it again. Both tests in
  // this file call openRoadmap(), so it must be idempotent rather than always
  // clicking.
  const openRoadmap = async (): Promise<void> => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    if (!(await roadmapButton.getAttribute('class')).includes('active')) {
      await roadmapButton.click()
    }
    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 75, {
      timeout: 20_000,
      timeoutMsg: 'expected 75 seeded roadmap rows across two categories',
    })
  }

  // This runs before the chevron-alignment test on purpose: that test ends
  // with saveAppScreenshot(), which pins #app to a fixed size via
  // prepareE2eScreenshot() (tests/e2e/helpers/screenshot.ts) and never undoes
  // it. Once pinned, `.roadmap-list` measured 0/0 for scrollHeight/clientHeight
  // in this suite — collapsing the list's real height — so a scroll-overflow
  // check running afterwards would be measuring a pinned, non-representative
  // layout. Running the unpinned layout first avoids that entirely.
  it('does not move the list scroll position when a group is toggled', async () => {
    await openRoadmap()

    const overflow = await browser.execute(() => {
      const lists = [...document.querySelectorAll('.roadmap-list')]
      const rows = document.querySelectorAll('.roadmap-row').length
      return {
        count: lists.length,
        rows,
        details: lists.map((list) => ({
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          display: getComputedStyle(list).display,
          overflowY: getComputedStyle(list).overflowY,
          connected: list.isConnected,
          offsetParent: list.parentElement?.className ?? null,
        })),
      }
    })
    assert.ok(
      overflow.details.some((d) => d.scrollHeight > d.clientHeight),
      `seeded rows must overflow the list for this test to mean anything: ${JSON.stringify(overflow)}`,
    )

    // Scroll partway down, past the bug group's rows, then collapse the
    // *feature* group at the bottom with a synthetic click (bypassing
    // WebDriver's native click, which would scroll the target into view
    // first and defeat the point of starting from a mid-list position).
    await browser.execute(() => {
      document.querySelector('.roadmap-list')!.scrollTop = 200
    })
    const before = await browser.execute(() => document.querySelector('.roadmap-list')!.scrollTop)
    assert.ok(before > 0, 'the list must actually have scrolled before toggling')

    await browser.execute(() => {
      const header = document.querySelector<HTMLElement>(
        '[data-category="feature"] .roadmap-category-header',
      )
      header?.click()
    })
    await browser.waitUntil(
      async () =>
        (await $('[data-category="feature"] .roadmap-category-header').getAttribute(
          'aria-expanded',
        )) === 'false',
      { timeout: 10_000, timeoutMsg: 'feature group never collapsed' },
    )
    const afterCollapse = await browser.execute(
      () => document.querySelector('.roadmap-list')!.scrollTop,
    )
    assert.equal(afterCollapse, before, 'collapsing a group must not move the scroll position')

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-category="feature"] .roadmap-category-header')
        ?.click()
    })
    await browser.waitUntil(
      async () =>
        (await $('[data-category="feature"] .roadmap-category-header').getAttribute(
          'aria-expanded',
        )) === 'true',
      { timeout: 10_000, timeoutMsg: 'feature group never re-expanded' },
    )
    const afterExpand = await browser.execute(
      () => document.querySelector('.roadmap-list')!.scrollTop,
    )
    assert.equal(afterExpand, before, 're-expanding a group must not move the scroll position')

    await saveAppScreenshot('roadmap-accordion-scroll-preserved.png')
  })

  it('centers the chevron on the category label', async () => {
    await openRoadmap()

    const geometry = await browser.execute(() => {
      const header = document.querySelector('[data-category="bug"] .roadmap-category-header')
      const chevron = header?.querySelector('.roadmap-category-chevron')
      const label = header?.querySelector('.roadmap-category-header-label')
      if (!chevron || !label) return null
      const chevronRect = chevron.getBoundingClientRect()
      const labelRect = label.getBoundingClientRect()
      return {
        chevronHeight: chevronRect.height,
        labelHeight: labelRect.height,
        chevronCenter: chevronRect.top + chevronRect.height / 2,
        labelCenter: labelRect.top + labelRect.height / 2,
      }
    })
    assert.ok(geometry, 'expected the bug category header, chevron, and label to exist')
    // A hidden/collapsed pane still matches the selectors above but reports
    // an all-zero rect, which would otherwise pass this check vacuously.
    assert.ok(geometry.chevronHeight > 0, 'the chevron must actually be rendered (nonzero height)')
    assert.ok(geometry.labelHeight > 0, 'the label must actually be rendered (nonzero height)')
    const offset = Math.abs(geometry.chevronCenter - geometry.labelCenter)
    assert.ok(
      offset <= 1,
      `expected the chevron's vertical center to land within 1px of the label's, got ${String(offset)}px`,
    )

    // Scroll to the top so the screenshot shows the header next to the rows
    // it groups — the frame that actually demonstrates the row-indent half of
    // this fix (rows lining up under the label, not the chevron).
    await browser.execute(() => {
      document.querySelector('.roadmap-list')!.scrollTop = 0
    })
    await saveAppScreenshot('roadmap-accordion-chevron-alignment.png')
  })
})
