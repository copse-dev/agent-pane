import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function waitForComposer(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 60_000 })
}

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => (await (await $('.workspace-name')).getText()) !== 'No folder',
    { timeout: 60_000, timeoutMsg: 'expected a restored workspace before opening Changes' },
  )
}

describe('git changes viewer', function () {
  this.timeout(120_000)

  let repoRoot = ''

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await waitForWorkspace()
    await waitForComposer()
  })

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('lists staged and unstaged changes and shows a diff', async () => {
    // The titlebar "Changes" shortcut opens the right panel and switches to the
    // Changes tab in one click.
    await $('.titlebar-btn[aria-label="Open changes"]').waitForExist({ timeout: 30_000 })
    const titlebarChangesBtn = await $('.titlebar-btn[aria-label="Open changes"]')
    await titlebarChangesBtn.click()

    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    await expect(titlebarChangesBtn).toHaveElementClass('active')

    const changesHost = await $('#git-changes-host')
    await changesHost.waitForDisplayed({ timeout: 30_000 })

    await (await $('.git-changes-refresh-btn')).click()

    // Wait for the async git status refresh to render rows.
    await browser.waitUntil(async () => (await $$('.git-change-row').length) >= 3, {
      timeout: 30_000,
      timeoutMsg: 'expected at least 3 changed-file rows',
    })
    const rows = await $$('.git-change-row')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-list.png'))

    // Section titles reflect staged vs unstaged counts. CSS uppercases the text,
    // so compare case-insensitively. Extra workspace artifacts (e.g. index DBs)
    // may inflate counts; assert the fixture files are present instead.
    const sectionTitles = (await $$('.git-changes-section-title').map((e) => e.getText())).map(
      (t) => t.toLowerCase(),
    )
    await expect(sectionTitles.some((t) => t.startsWith('staged ('))).toBe(true)
    await expect(sectionTitles.some((t) => t.startsWith('unstaged ('))).toBe(true)

    // Verify the three expected files appear with status badges.
    const paths = await $$('.git-change-path').map((e) => e.getText())
    await expect(paths).toContain('staged.ts')
    await expect(paths).toContain('unstaged.ts')
    await expect(paths).toContain('untracked.ts')

    const untrackedBadge = await $('.git-change-status-untracked')
    await expect(untrackedBadge).toHaveText('?')

    // A shell command or external editor does not register the file-viewer
    // fs.watch used by the renderer. Keep the panel open and create such a
    // file; the recursive execution-root subscription must discover it without
    // Refresh (#1753).
    writeFileSync(join(repoRoot, 'external-change.ts'), 'export const externallyChanged = true\n')
    await browser.waitUntil(
      async () =>
        (await $$('.git-change-path').map((element) => element.getText())).includes(
          'external-change.ts',
        ),
      {
        timeout: 10_000,
        timeoutMsg: 'expected an unwatched external change to appear automatically',
      },
    )
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-external-refresh.png'))

    // Opening the panel auto-selects the first changed file (staged.ts).
    const stagedRow = await rows.find(
      async (r) => (await r.$('.git-change-path').getText()) === 'staged.ts',
    )
    await expect(stagedRow).toHaveElementClass('is-selected')

    const diffViewer = await $('#git-diff-viewer-host .monaco-diff-editor')
    await diffViewer.waitForDisplayed({ timeout: 30_000 })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-diff.png'))

    // Large staged.ts diffs collapse unchanged lines with context + expandable regions.
    await browser.waitUntil(async () => (await $$('.diff-hidden-lines-widget').length) >= 1, {
      timeout: 30_000,
      timeoutMsg: 'expected collapsed unchanged regions in the diff viewer',
    })

    // The staged change sits mid-file. After lazy Monaco load, a reveal race used
    // to leave the viewport at the top with no visible change. Assert insert/
    // delete decorations are present (Monaco virtualizes line text, so querying
    // raw `value = 2` textContent is unreliable in inline mode).
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const host = document.querySelector('#git-diff-viewer-host')
          if (!host) return false
          const hasInsert = host.querySelector('.line-insert, .char-insert') != null
          const hasDelete = host.querySelector('.line-delete, .char-delete') != null
          return hasInsert && hasDelete
        })
      },
      {
        timeout: 15_000,
        timeoutMsg: 'expected insert+delete decorations for the mid-file change',
      },
    )

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-diff-collapsed.png'))

    const expandBtn = await $('.diff-hidden-lines-widget a[role="button"]')
    await expandBtn.click()
    await browser.pause(300)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-diff-expanded.png'))
  })
})
