import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// The Roadmap header holds the title, pane buttons, search + Filter and five
// action buttons. In a narrow pane the search box used to be squeezed to
// "Search r…" beside Filter; the group now wraps onto its own row instead.
describe('roadmap search box in a narrow pane', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-search-narrow-'))
    knowledgeDir = seedRoadmapNotes('e2e-roadmap-search-narrow', [
      { id: 'thread-0', title: 'Roadmap thread 1', body: 'Prompt body.' },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-search-narrow', {
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

  it('keeps the placeholder readable instead of squeezing the input', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-text-btn[aria-label="Open roadmap"]').click()
    await browser.waitUntil(async () => (await $$('.roadmap-row')).length === 1, {
      timeout: 20_000,
    })

    const widths = await browser.execute(() => {
      const input = document.querySelector('.roadmap-search-input')
      return input ? { inputWidth: input.getBoundingClientRect().width } : null
    })
    assert.ok(widths, 'search input must exist')
    assert.ok(
      widths.inputWidth >= 130,
      `search input is ${String(widths.inputWidth)}px wide; the placeholder would be truncated`,
    )
    await saveAppScreenshot('roadmap-search-narrow.png')
  })
})
