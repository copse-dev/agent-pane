import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

/**
 * Visual eval for the quieter Roadmap list: title-first single-line rows,
 * silent `ready`, exceptional status chips only, muted trailing icons.
 * See docs/ui-taste.md "Roadmap list rows".
 */
describe('roadmap list rows (quiet single-line layout)', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-list-'))
    knowledgeDir = seedRoadmapNotes(workspaceRoot, [
      {
        id: 'e2e-roadmap-ready',
        title: 'Refactor the settings dialog',
        body: 'Rewrite settings layout without visual noise.',
        status: 'ready',
      },
      {
        id: 'e2e-roadmap-blocked',
        title: 'Port e2e specs to component tests',
        body: 'Waiting on the migration plan.',
        status: 'blocked',
      },
      {
        id: 'e2e-roadmap-conflicts',
        title: 'Align permission policy docs',
        body: 'Conflicts with the sandbox matrix rewrite.',
        status: 'conflicts',
      },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-list-rows', {
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

  it('renders title-first rows with silent ready and exceptional status chips', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()

    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 3, {
      timeout: 20_000,
      timeoutMsg: 'expected three seeded roadmap rows',
    })

    // Knowledge-store orphans with identical createdAt sort by id, so the
    // seeded ids (…-blocked / …-conflicts / …-ready) dictate list order.
    const titles = await $$('.roadmap-row-title').map((row) => row.getText())
    assert.deepEqual(titles, [
      'Port e2e specs to component tests',
      'Align permission policy docs',
      'Refactor the settings dialog',
    ])

    const badges = await $$('.roadmap-status-badge').map((badge) => badge.getText())
    assert.deepEqual(
      badges.map((t) => t.toLowerCase()),
      ['blocked', 'conflicts'],
      'ready stays silent; only exceptional statuses chip',
    )

    // Mark-done exists in the DOM but is opacity-hidden until hover — still
    // keyboard-reachable / clickable for automation.
    assert.equal(await $$('.roadmap-done-toggle').length, 3)
    const toggleOpacity = await browser.execute(() => {
      const toggle = document.querySelector<HTMLElement>('.roadmap-done-toggle')
      return toggle ? getComputedStyle(toggle).opacity : null
    })
    assert.equal(toggleOpacity, '0', 'done toggle is hidden at rest')

    const singleLine = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('.roadmap-row .memories-row-main')
      if (!row) return null
      return getComputedStyle(row).flexDirection
    })
    assert.equal(singleLine, 'row', 'title + trailing indicators share one line')

    await expect($('.roadmap-row-meta')).toExist()
    await saveAppScreenshot('roadmap-list-rows.png')
  })
})
