import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Import picker rows: checkbox inline beside the title (not stacked/centered by
// the global label { flex-direction: column } rule). Uses the mock GitHub
// backend's open-issue fixtures (#41, #52).
describe('roadmap import picker', () => {
  let workspaceRoot: string | undefined

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    // Keep .git inside the seeded workspace. The source checkout may itself be
    // a linked worktree whose external gitdir is correctly hidden by the app's
    // project sandbox, which would make origin detection environment-dependent.
    workspaceRoot = join(tmpdir(), 'copse-roadmap-import-workspace')
    rmSync(workspaceRoot, { recursive: true, force: true })
    mkdirSync(workspaceRoot, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: workspaceRoot, stdio: 'pipe' })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/copse-mock/demo.git'], {
      cwd: workspaceRoot,
      stdio: 'pipe',
    })
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-import', {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists open issues with inline checkboxes', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-import-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-import-btn').click()
    await $('.roadmap-import').waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(async () => (await $$('.roadmap-import-row')).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'expected mock open issues in the import picker',
    })

    const layout = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('.roadmap-import-row')
      const check = row?.querySelector<HTMLElement>('.roadmap-import-check')
      const title = row?.querySelector<HTMLElement>('.roadmap-import-title')
      if (!row || !check || !title) return null
      const style = getComputedStyle(row)
      return {
        flexDirection: style.flexDirection,
        rowTop: row.getBoundingClientRect().top,
        checkTop: check.getBoundingClientRect().top,
        titleTop: title.getBoundingClientRect().top,
        checkLeft: check.getBoundingClientRect().left,
        titleLeft: title.getBoundingClientRect().left,
        titles: [...document.querySelectorAll('.roadmap-import-title')].map((e) => e.textContent),
      }
    })
    assert.ok(layout, 'import row layout must exist')
    assert.equal(layout.flexDirection, 'row', 'checkbox and title share one horizontal row')
    assert.ok(layout.checkLeft < layout.titleLeft, 'checkbox sits to the left of the title')
    // Tops within ~a line — stacked column layout puts the checkbox well below.
    assert.ok(
      Math.abs(layout.checkTop - layout.titleTop) < 20,
      'checkbox and title are vertically aligned',
    )
    assert.ok(
      layout.titles.some((t) => t?.includes('#41')),
      'mock issue #41 is listed',
    )
    assert.ok(
      layout.titles.some((t) => t?.includes('#52')),
      'mock issue #52 is listed',
    )

    await saveAppScreenshot('roadmap-import-picker.png')
  })
})
