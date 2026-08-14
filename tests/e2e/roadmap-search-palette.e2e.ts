import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedRoadmapNotes } from './helpers/seed-config.ts'

// The Cmd/Ctrl+P quick-open palette doubles as a light "search everywhere":
// with roadmap plans enabled, a typed query also matches the project's roadmap
// items, rendered in a labelled "Roadmap" section under the file matches.
// Choosing one opens the Roadmap pane with that item selected — this spec
// drives that full path against seeded OKF notes.
describe('roadmap items in the quick-open palette (Cmd/Ctrl+P)', () => {
  let workspaceRoot: string
  let knowledgeDir: string

  before(async () => {
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-search-'))
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'README.md'), '# Fixture\n', 'utf8')
    knowledgeDir = seedRoadmapNotes('e2e-roadmap-search', [
      {
        id: 'e2e-roadmap-quokka',
        title: 'Polish the quokka onboarding flow',
        body: 'Polish the quokka onboarding flow end to end.',
        status: 'ready',
      },
      {
        id: 'e2e-roadmap-other',
        title: 'Ship dark-mode screenshots',
        body: 'Add dark-mode screenshots to the docs.',
        status: 'blocked',
      },
    ])
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-search', { roadmapPlansEnabled: true })
    await browser.reloadSession()
    // Until workspaceRoot is set the shortcut no-ops, so wait for boot.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(knowledgeDir, { recursive: true, force: true })
  })

  it('lists a matching roadmap item and opens it in the Roadmap pane', async () => {
    const dialog = await $('#file-search-dialog')

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', metaKey: true, ctrlKey: true, bubbles: true }),
      )
    })
    await dialog.waitForDisplayed({ timeout: 10_000 })

    // Results wait on the workspace file index even for roadmap matches (the
    // query runs both lookups), so keep re-typing until the row surfaces —
    // the same pattern as the file-search palette spec.
    const input = await $('.file-search-input')
    await browser.waitUntil(
      async () => {
        await input.setValue('quokka')
        const rows = await $$('.file-search-roadmap-item')
        return rows.length > 0
      },
      { timeout: 20_000, interval: 1000, timeoutMsg: 'no roadmap result for "quokka"' },
    )

    // Only the quokka item matches; it renders under the "Roadmap" section
    // header. Default `ready` stays silent (no status chip) — same rule as the
    // Roadmap list.
    const section = await $('.file-search-section')
    await expect(section).toHaveText('roadmap', { ignoreCase: true })
    const rows = await $$('.file-search-roadmap-item')
    expect(rows.length).toBe(1)
    const name = await $('.file-search-roadmap-item .file-search-name')
    await expect(name).toHaveText('Polish the quokka onboarding flow')
    assert.equal(
      await $('.file-search-roadmap-item .roadmap-status-badge').isExisting(),
      false,
      'ready items omit the status chip in the palette',
    )

    await saveAppScreenshot('roadmap-search-palette.png')

    // Choosing the match closes the palette and lands in the Roadmap pane with
    // the item selected and its editor populated.
    const row = await $('.file-search-roadmap-item')
    await row.click()
    await dialog.waitForDisplayed({ timeout: 10_000, reverse: true })

    const selectedTitle = await $('.roadmap-row.is-selected .roadmap-row-title')
    await selectedTitle.waitForDisplayed({ timeout: 10_000 })
    await expect(selectedTitle).toHaveText('Polish the quokka onboarding flow')
    const prompt = await $('.roadmap-prompt-input')
    await expect(prompt).toHaveValue('Polish the quokka onboarding flow end to end.')

    await saveAppScreenshot('roadmap-search-palette-opened.png')
  })
})
