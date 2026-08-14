import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// The file viewer's "Changes" view (#file-viewer): opening a file with
// uncommitted changes surfaces a Changes toggle in the viewer toolbar that
// swaps the editor for a HEAD → working-tree Monaco diff of that file.

const PROJECT_ID = 'e2e-file-viewer-changes-project'
const CHANGED_FILE = 'sample.ts'
const CLEAN_FILE = 'clean.ts'

function seedGitWorkspace(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'copse-file-viewer-changes-'))
  const git = (...args: string[]): Buffer =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })

  const baseline = [
    'export function makeServer() {',
    '  const port = 3000',
    '  return { port, listen: () => console.log(port) }',
    '}',
    '',
  ].join('\n')
  writeFileSync(join(repoRoot, CHANGED_FILE), baseline, 'utf8')
  writeFileSync(join(repoRoot, CLEAN_FILE), 'export const untouched = true\n', 'utf8')

  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'E2E')
  git('config', 'commit.gpgsign', 'false')
  git('add', '.')
  git('commit', '-q', '-m', 'baseline')

  // Uncommitted edit: change the port and add a comment line.
  writeFileSync(
    join(repoRoot, CHANGED_FILE),
    [
      '// Now configurable via PORT',
      'export function makeServer() {',
      '  const port = Number(process.env.PORT ?? 3000)',
      '  return { port, listen: () => console.log(port) }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )

  return repoRoot
}

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name')
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

async function openFileFromTree(fileName: string): Promise<void> {
  const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
  if (!(await $('#pane-files').isDisplayed())) await panelBtn.click()
  await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

  const row = await $(`.tree-row[title="${fileName}"]`)
  await row.waitForDisplayed({ timeout: 30_000 })
  await row.click()

  await $('#file-viewer .monaco-editor').waitForDisplayed({ timeout: 30_000 })
}

describe('file viewer Changes view', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = seedGitWorkspace()
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
    await waitForWorkspace()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('offers browser opening from the file tree before opening a file', async () => {
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    if (!(await $('#pane-files').isDisplayed())) await panelBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    const row = await $(`.tree-row[title="${CLEAN_FILE}"]`)
    await row.waitForDisplayed({ timeout: 30_000 })
    await row.click({ button: 'right' })

    const menu = await $('.context-menu')
    await menu.waitForDisplayed({ timeout: 5_000 })
    await expect($('.context-menu-item')).toHaveText('Open in browser')
    await saveAppScreenshot('file-tree-open-in-browser-menu.png')

    await browser.keys('Escape')
    await expect(menu).not.toBeExisting()
  })

  it('shows a Changes toggle for a modified file and renders its diff', async () => {
    await openFileFromTree(CHANGED_FILE)

    const changesBtn = await $('#file-viewer .file-viewer-changes-btn')
    await changesBtn.waitForDisplayed({ timeout: 30_000 })
    await expect(changesBtn).toHaveText('Changes')

    const sourceBtn = await $('#file-viewer .file-viewer-source-btn')
    await expect(sourceBtn).toHaveText('Source')
    await expect(sourceBtn).toHaveElementClass('is-active')

    await changesBtn.click()
    await expect(changesBtn).toHaveElementClass('is-active')

    const diffEditor = await $('#file-viewer .file-viewer-diff .monaco-diff-editor')
    await diffEditor.waitForDisplayed({ timeout: 30_000 })

    // The uncommitted edit must surface insert decorations (added comment +
    // changed port line) against the HEAD baseline.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const host = document.querySelector('#file-viewer .file-viewer-diff')
          return host?.querySelector('.line-insert, .char-insert') != null
        }),
      { timeout: 15_000, timeoutMsg: 'expected insert decorations in the file viewer diff' },
    )

    await saveAppScreenshot('file-viewer-changes-diff.png')
  })

  it('returns to the editor via the Source toggle', async () => {
    const sourceBtn = await $('#file-viewer .file-viewer-source-btn')
    await sourceBtn.click()
    await expect(sourceBtn).toHaveElementClass('is-active')

    await $('#file-viewer .monaco-container .monaco-editor').waitForDisplayed({ timeout: 15_000 })
    const diffWrap = await $('#file-viewer .file-viewer-diff')
    await expect(diffWrap).not.toBeDisplayed()

    await saveAppScreenshot('file-viewer-changes-source.png')
  })

  it('offers to open the viewed file in the browser on right-click', async () => {
    const editor = await $('#file-viewer .monaco-container')
    await editor.click({ button: 'right' })

    const menu = await $('.context-menu')
    await menu.waitForDisplayed({ timeout: 5_000 })
    await expect($('.context-menu-item')).toHaveText('Open in browser')
    await saveAppScreenshot('file-viewer-default-browser-menu.png')

    await browser.keys('Escape')
    await expect(menu).not.toBeExisting()
  })

  it('shows no toolbar for a clean file', async () => {
    await openFileFromTree(CLEAN_FILE)

    // The changes probe is async; give it a beat, then the toolbar must stay hidden.
    await browser.pause(1_000)
    const toolbar = await $('#file-viewer .file-viewer-toolbar')
    await expect(toolbar).not.toBeDisplayed()

    await saveAppScreenshot('file-viewer-changes-clean-file.png')
  })
})
