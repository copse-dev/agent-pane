import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { assertNeutralBadge, readBadgeStyles, signalColours } from './helpers/badge-style.ts'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('roadmap category grouping and filters', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-categories-'))
    knowledgeDir = seedRoadmapNotes('e2e-roadmap-category-filter', [
      {
        id: 'bug-high',
        title: 'Fix startup crash',
        body: 'Prevent the startup crash.',
        category: 'bug',
        complexity: 'high',
      },
      {
        id: 'bug-low',
        title: 'Fix tooltip copy',
        body: 'Correct the tooltip wording.',
        category: 'bug',
        complexity: 'low',
      },
      {
        id: 'feature-medium',
        title: 'Add export presets',
        body: 'Add reusable export presets.',
        category: 'feature',
        complexity: 'medium',
      },
      {
        id: 'project-high',
        title: 'Migrate the storage layer',
        body: 'Move persistence to the new format.',
        category: 'project',
        complexity: 'high',
        // Blocked, so the status badge sits beside the `project` category badge
        // in the same row: only the status may take the warning hue.
        status: 'blocked',
      },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-category-filter', {
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

  it('shows category accordions and filters category and complexity', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-text-btn[aria-label="Open roadmap"]').click()
    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 4, {
      timeout: 20_000,
      timeoutMsg: 'expected four categorized roadmap rows',
    })

    const bugHeader = $('[data-category="bug"] .roadmap-category-header')
    assert.equal(await bugHeader.getAttribute('aria-expanded'), 'true')
    assert.equal(await $('[data-category="bug"] .roadmap-category-count').getText(), '2')
    assert.equal((await $$('.roadmap-category-badge')).length, 4)

    // Category is a label, not a status: every category chip is the same neutral
    // colour, and `project` no longer matches the `blocked` status beside it.
    const signals = await signalColours()
    const categories = await readBadgeStyles('.roadmap-category-badge')
    for (const category of categories) assertNeutralBadge(category, signals)
    assert.equal(
      new Set(categories.map((category) => category.color)).size,
      1,
      'categories are not colour-coded',
    )
    const [blocked] = await readBadgeStyles('.roadmap-status-badge.is-blocked')
    assert.ok(blocked, 'the blocked status badge renders')
    assert.equal(blocked.color, signals.find((signal) => signal.token === '--warning')?.value)
    const project = categories.find((category) => category.text === 'project')
    assert.ok(project)
    assert.notEqual(project.color, blocked.color, 'project category ≠ blocked status colour')
    // The `done` toolbar toggle is gone; status is a filter facet now.
    assert.equal((await $$('.roadmap-show-done-btn')).length, 0)

    await bugHeader.click()
    assert.equal(await bugHeader.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await $('[data-category="bug"] .roadmap-category-items').getAttribute('hidden'),
      'true',
    )
    await bugHeader.click()

    await $('.roadmap-filter-toggle').click()
    assert.equal(await $('.roadmap-filter-toggle').getAttribute('aria-expanded'), 'true')
    // `getText()` returns *rendered* text, and `.roadmap-filter-heading` carries
    // `text-transform: uppercase` (roadmap.css) — so assert what the user sees.
    assert.equal(
      await $$('.roadmap-filter-heading')
        .map((heading) => heading.getText())
        .then((texts) => texts.join(',')),
      'CATEGORY,COMPLEXITY,STATUS',
    )

    await saveAppScreenshot('roadmap-category-filter.png')
  })
})
