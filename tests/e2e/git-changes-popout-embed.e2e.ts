import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// #1753. With the Changes pane popped out into its own window, the docked
// Changes pane in the main window rendered the selected file with no diff
// colouring — no insert/delete decorations at all — while the pop-out rendered
// the same file fully coloured. Both windows must keep a coloured diff through
// pop-out, external working-tree changes, and re-selection.

async function hasDiffDecorations(): Promise<boolean> {
  return browser.execute(() => {
    const host = document.querySelector('#git-diff-viewer-host')
    if (!host) return false
    return host.querySelector('.line-insert, .char-insert, .line-delete, .char-delete') != null
  })
}

async function describeViewer(): Promise<string> {
  return browser.execute(() => {
    const host = document.querySelector('#git-diff-viewer-host')
    if (!host) return 'no #git-diff-viewer-host'
    return JSON.stringify({
      hasEditor: host.querySelector('.monaco-diff-editor') != null,
      lines: host.querySelectorAll('.view-line').length,
      inserts: host.querySelectorAll('.line-insert, .char-insert').length,
      deletes: host.querySelectorAll('.line-delete, .char-delete').length,
    })
  })
}

/** The files `seedGitChangesFixture` puts in the tree, and nothing else. */
const FIXTURE_ROWS = ['staged.ts', 'unstaged.ts', 'untracked.ts', 'committed.ts'] as const

/**
 * Wait until the Changes list shows the fixture's files and nothing else.
 *
 * Two windows poll `git status` here, and each status runs in the project
 * sandbox. On Linux, bubblewrap materialises every *missing* mandatory-deny
 * path (`.bashrc`, `.gitconfig`, `.claude/commands`, …) as an empty bind-mount
 * target inside the workspace, and the sandbox runtime defers deleting those
 * while another sandboxed command is still running — deleting one early would
 * detach the other sandbox's deny mount. So while the docked pane's status and
 * the pop-out's overlap, either window can list a dozen dotfiles nobody wrote.
 * They disappear on their own once the commands finish.
 *
 * The product is right to show what git reports, so this is the spec's job, not
 * a filter in `getGitStatus`: wait for the transient rows to clear before
 * capturing, which also asserts the pane shows the state the fixture seeded.
 */
async function waitForFixtureRows(): Promise<void> {
  let seen: string[] = []
  try {
    await browser.waitUntil(
      async () => {
        seen = await browser.execute(() =>
          Array.from(document.querySelectorAll('.git-change-row')).map((row) =>
            (row.textContent ?? '').trim(),
          ),
        )
        if (seen.length !== FIXTURE_ROWS.length) return false
        return FIXTURE_ROWS.every((name) => seen.some((text) => text.includes(name)))
      },
      { timeout: 30_000, interval: 250 },
    )
  } catch {
    throw new Error(
      `the Changes list never settled on the fixture's ${String(FIXTURE_ROWS.length)} files ` +
        `(${FIXTURE_ROWS.join(', ')}); last saw ${String(seen.length)}: ${JSON.stringify(seen)}`,
    )
  }
}

describe('git changes embed alongside pop-out (#1753)', function () {
  this.timeout(240_000)

  let repoRoot = ''
  let mainHandle = ''

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await browser.waitUntil(
      async () => (await (await $('.workspace-name')).getText()) !== 'No folder',
      { timeout: 60_000, timeoutMsg: 'expected a restored workspace' },
    )
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    mainHandle = (await browser.getWindowHandles())[0]
  })

  after(async () => {
    try {
      await browser.switchToWindow(mainHandle)
    } catch {
      // session already gone
    }
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('keeps diff colouring in the docked pane while the pop-out is open', async () => {
    await $('.titlebar-btn[aria-label="Open changes"]').click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })

    await browser.waitUntil(async () => (await $$('.git-change-row').length) >= 3, {
      timeout: 30_000,
      timeoutMsg: 'expected changed-file rows in the docked pane',
    })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDiffDecorations, {
      timeout: 15_000,
      timeoutMsg: `docked pane never showed diff decorations before pop-out: ${await describeViewer()}`,
    })

    // Pop the Changes pane out into its own window.
    const before = await browser.getWindowHandles()
    await $('#git-changes-host .pane-popout-btn').click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'expected a pop-out window',
    })
    const popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
    expect(popoutHandle).toBeDefined()

    await browser.switchToWindow(popoutHandle as string)
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.documentElement.getAttribute('data-popout-mode') === 'changes',
        ),
      { timeout: 20_000, timeoutMsg: 'pop-out did not boot in changes mode' },
    )
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDiffDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out never showed diff decorations: ${await describeViewer()}`,
    })
    await waitForFixtureRows()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-popout-embed-popout.png'))

    // Back in the main window, the docked pane must still be coloured, and must
    // stay coloured through a working-tree change and a re-selection — the two
    // refresh paths that used to re-enter the viewer while the pop-out was open.
    await browser.switchToWindow(mainHandle)
    writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const name = "newer"\n', 'utf8')
    await browser.waitUntil(hasDiffDecorations, {
      timeout: 15_000,
      timeoutMsg: `docked pane lost decorations after an external change: ${await describeViewer()}`,
    })

    const stagedRow = await $('.git-change-row*=staged.ts')
    await stagedRow.click()
    await browser.waitUntil(hasDiffDecorations, {
      timeout: 15_000,
      timeoutMsg: `docked pane lost decorations after re-selection: ${await describeViewer()}`,
    })
    await waitForFixtureRows()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-popout-embed-docked.png'))

    // And the pop-out still shows them too.
    await browser.switchToWindow(popoutHandle as string)
    await browser.waitUntil(hasDiffDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out lost diff decorations: ${await describeViewer()}`,
    })
    try {
      await browser.closeWindow()
    } catch {
      // leave it for session teardown
    }
    await browser.switchToWindow(mainHandle)
  })
})
