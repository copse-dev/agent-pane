import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveAppScreenshot,
} from './helpers/screenshot.ts'

// The Roadmap header holds the title, pane buttons, search + Filter and five
// action buttons. In a narrow pane the search box used to be squeezed to
// "Search r…" beside Filter; the group now wraps onto its own row instead.
describe('roadmap search box in a narrow pane', () => {
  let workspaceRoot: string
  let scratchRoot: string
  let knowledgeDir: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    scratchRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-search-narrow-'))
    workspaceRoot = join(scratchRoot, 'roadmap-search-project')
    mkdirSync(workspaceRoot)
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
    rmSync(scratchRoot, { recursive: true, force: true })
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('keeps the placeholder readable instead of squeezing the input', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-text-btn[aria-label="Open roadmap"]').click()
    await browser.waitUntil(async () => (await $$('.roadmap-row').getElements()).length === 1, {
      timeout: 20_000,
    })

    const mainHandle = await browser.getWindowHandle()
    const before = await browser.getWindowHandles()
    await $('#roadmap-host .pane-popout-btn').click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length)
    const popout = (await browser.getWindowHandles()).find((handle) => !before.includes(handle))
    assert.ok(popout)
    await browser.switchToWindow(popout)
    await browser.waitUntil(() =>
      browser.execute(() => document.documentElement.dataset['popoutMode'] === 'roadmap'),
    )
    await $('.roadmap-search-input').waitForDisplayed()
    await prepareE2eScreenshot({ width: 1024, height: 800 })
    const widths = await browser.execute(() => {
      const input = document.querySelector('.roadmap-search-input')
      const toggle = document.querySelector('.roadmap-filter-toggle')
      const header = document.querySelector('.roadmap-list-header')
      if (!input || !toggle || !header) return null
      return {
        inputWidth: input.getBoundingClientRect().width,
        toggleRight: toggle.getBoundingClientRect().right,
        headerRight: header.getBoundingClientRect().right,
      }
    })
    assert.ok(widths, 'search input, Filter toggle and header must exist')
    assert.ok(
      widths.toggleRight <= widths.headerRight + 1,
      `Filter toggle ends at ${String(widths.toggleRight)}px, past the header edge ${String(widths.headerRight)}px (clipped)`,
    )
    assert.ok(
      widths.inputWidth >= 130,
      `search input is ${String(widths.inputWidth)}px wide; the placeholder would be truncated`,
    )
    await saveAppScreenshot('roadmap-search-narrow.png', { width: 1024, height: 800 })
    await browser.switchToWindow(mainHandle)
  })
})
