import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-popout-proposed-project'
// A non-git workspace (outside any enclosing repo — git walks up from nested
// dirs): `canApplyDirectly` requires git, so every mock write stages a proposed
// diff for approval instead of applying directly.
const WORKSPACE = join(tmpdir(), 'copse-e2e-popout-proposed-workspace')

// #1753 / #1704. Proposed diffs reach every app window; the docked Changes pane
// and a Changes pop-out must both render them coloured through proposals made
// while the pop-out is open, approvals made in either window, and a proposal
// arriving while the main window's panel is closed.

async function waitForAgentIdle(timeoutMs = 60_000): Promise<void> {
  await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Send', {
    timeout: timeoutMs,
    interval: 500,
    timeoutMsg: 'Agent did not return to idle',
  })
}

async function runWriteFileDirective(path: string, content: string): Promise<void> {
  const args = JSON.stringify({ path, content })
  await setComposerValue(`[[mcp:write_file ${args}]]`)
  await $('.submit-btn').click()
  await waitForAgentIdle()
}

async function hasDecorations(): Promise<boolean> {
  return browser.execute(() => {
    const host = document.querySelector('#git-diff-viewer-host')
    return host?.querySelector('.line-insert, .char-insert, .line-delete, .char-delete') != null
  })
}

async function describeViewer(): Promise<string> {
  return browser.execute(() => {
    const host = document.querySelector('#git-diff-viewer-host')
    if (!host) return 'no #git-diff-viewer-host'
    return JSON.stringify({
      selected:
        document.querySelector('.git-change-row.is-selected .git-change-path')?.textContent ?? null,
      hasEditor: host.querySelector('.monaco-diff-editor') != null,
      inserts: host.querySelectorAll('.line-insert, .char-insert').length,
      deletes: host.querySelectorAll('.line-delete, .char-delete').length,
    })
  })
}

describe('proposed diffs across embed and pop-out (#1753)', function () {
  this.timeout(300_000)

  let mainHandle = ''
  let popoutHandle = ''

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    mkdirSync(WORKSPACE, { recursive: true })
    resetUserData()
    seedEmptyProject(WORKSPACE, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
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
    rmSync(WORKSPACE, { recursive: true, force: true })
  })

  it('keeps the embed coloured through proposals and pop-out approvals', async () => {
    // First proposal opens the Changes panel and stages the diff.
    await runWriteFileDirective('src/e2e-popout-a.ts', 'export const a = 1\n')
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 30_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `embed never coloured the first proposal: ${await describeViewer()}`,
    })

    // Pop the Changes pane out.
    const before = await browser.getWindowHandles()
    await $('#git-changes-host .pane-popout-btn').click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'expected a pop-out window',
    })
    popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h)) as string
    expect(popoutHandle).toBeDefined()

    await browser.switchToWindow(popoutHandle)
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out never coloured the proposal: ${await describeViewer()}`,
    })

    // Second proposal from the main window while the pop-out is open.
    await browser.switchToWindow(mainHandle)
    await runWriteFileDirective('src/e2e-popout-b.ts', 'export const b = 2\n')
    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'expected two proposed rows in the embed',
    })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `embed lost colouring on the second proposal: ${await describeViewer()}`,
    })

    await browser.switchToWindow(popoutHandle)
    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'expected two proposed rows in the pop-out',
    })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out lost colouring on the second proposal: ${await describeViewer()}`,
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-popout-proposed.png'))

    // Approve the selected diff in the pop-out; both windows fall back to the
    // remaining proposal and must colour it.
    const acceptBtn = await $('#git-diff-viewer-host .diff-accept-btn')
    await acceptBtn.waitForDisplayed({ timeout: 10_000 })
    await acceptBtn.click()
    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 1, {
      timeout: 30_000,
      timeoutMsg: 'expected the approved row to leave the pop-out queue',
    })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out uncoloured after its own approve: ${await describeViewer()}`,
    })

    await browser.switchToWindow(mainHandle)
    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 1, {
      timeout: 30_000,
      timeoutMsg: 'expected the approved row to leave the embed queue',
    })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `embed uncoloured after the pop-out approve: ${await describeViewer()}`,
    })
  })

  it('force-opens the embed coloured when a proposal arrives with its panel closed', async () => {
    // The realistic sequence behind #1753: the user works in the pop-out with
    // the main window's panel closed; a new proposal must reveal a coloured
    // embed.
    await browser.switchToWindow(mainHandle)
    const paneFiles = await $('#pane-files')
    if (await paneFiles.isDisplayed()) {
      await $('.titlebar-btn[aria-label="Open changes"]').click()
      await browser.waitUntil(async () => !(await paneFiles.isDisplayed()), {
        timeout: 10_000,
        timeoutMsg: 'expected the main-window panel to close',
      })
    }

    await runWriteFileDirective('src/e2e-popout-c.ts', 'export const c = 3\n')
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `force-opened embed is uncoloured: ${await describeViewer()}`,
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-popout-proposed-forced.png'))

    await browser.switchToWindow(popoutHandle)
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out uncoloured for the third proposal: ${await describeViewer()}`,
    })
    try {
      await browser.closeWindow()
    } catch {
      // leave it for session teardown
    }
    await browser.switchToWindow(mainHandle)
  })
})
