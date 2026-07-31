import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('roadmap category grouping and filters', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-categories-'))
    knowledgeDir = seedRoadmapNotes(workspaceRoot, [
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
    assert.equal(
      await $$('.roadmap-filter-heading')
        .map((heading) => heading.getText())
        .then((texts) => texts.join(',')),
      'Category,Complexity,Status',
    )

    await saveAppScreenshot('roadmap-category-filter.png')
  })
})
