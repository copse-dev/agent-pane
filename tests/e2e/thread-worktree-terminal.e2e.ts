import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-worktree-terminal-project'
const THREAD_ID = 'e2e-worktree-terminal-thread'
const WORKTREE_BRANCH = 'copse/e2e-worktree-terminal'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function xtermText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

describe('isolated thread terminal cwd', () => {
  let projectRoot = ''
  let worktreeRoot = ''

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(dirname(worktreesRoot), 'project-checkout')
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    writeFileSync(join(projectRoot, 'README.md'), 'terminal worktree fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])

    worktreeRoot = join(worktreesRoot, PROJECT_ID, THREAD_ID)
    mkdirSync(dirname(worktreeRoot), { recursive: true })
    const baseBranch = git(projectRoot, ['branch', '--show-current'])
    const baseCommit = git(projectRoot, ['rev-parse', 'HEAD'])
    git(projectRoot, ['worktree', 'add', '-q', '-b', WORKTREE_BRANCH, worktreeRoot])
    writeFileSync(join(projectRoot, 'project-only.md'), '# Shared project only\n')
    writeFileSync(
      join(worktreeRoot, 'worktree-only.md'),
      '# Isolated worktree file\n\nThis content must come from the active task checkout.\n',
    )

    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Isolated terminal',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          gitBranch: WORKTREE_BRANCH,
          worktreeChoice: 'worktree',
          worktree: {
            path: worktreeRoot,
            branch: WORKTREE_BRANCH,
            baseBranch,
            baseCommit,
            createdAt: now,
            seededFromDirtyProject: false,
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('starts a new shell in the active thread worktree', async function () {
    this.timeout(90_000)
    const terminalBtn = await $('#titlebar .titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await approveUnsandboxedTerminalIfPrompted()

    const terminal = await $('.terminal-container .xterm')
    await terminal.waitForExist({ timeout: 30_000 })
    const helper = await $('.xterm-helper-textarea')
    await helper.click()
    await browser.keys(['pwd', '\uE007'])

    await browser.waitUntil(async () => (await xtermText()).includes(worktreeRoot), {
      timeout: 30_000,
      timeoutMsg: 'expected the terminal cwd to be the active thread worktree',
    })

    // Clear host-shell startup noise before the visual reference, then show the
    // isolated branch as a stable, human-readable confirmation of the checkout.
    await browser.keys(['clear', '\uE007'])
    await browser.keys(['git', ' ', 'branch', ' ', '--show-current', '\uE007'])
    await browser.waitUntil(async () => (await xtermText()).includes(WORKTREE_BRANCH), {
      timeout: 30_000,
      timeoutMsg: 'expected the terminal to report the isolated worktree branch',
    })
    await expect(terminalBtn).toHaveElementClass('active')
    await saveAppScreenshot('thread-worktree-terminal-cwd.png')
  })

  it('lists and previews files from the active thread worktree', async function () {
    this.timeout(60_000)
    const explorerBtn = await $('#titlebar .titlebar-btn[aria-label="Toggle right panel"]')
    await explorerBtn.click()

    const worktreeFile = await $('.file-tree .tree-row[title="worktree-only.md"]')
    await worktreeFile.waitForDisplayed({ timeout: 30_000 })
    await expect($('.file-tree .tree-row[title="project-only.md"]')).not.toExist()
    await worktreeFile.click()

    const preview = await $('.markdown-file-preview')
    await preview.waitForDisplayed({ timeout: 30_000 })
    await expect(preview).toHaveText(expect.stringContaining('Isolated worktree file'))
    await expect(preview).toHaveText(
      expect.stringContaining('This content must come from the active task checkout.'),
    )

    await expect(explorerBtn).toHaveElementClass('active')
    await saveAppScreenshot('thread-worktree-file-viewer.png')
  })

  it('shows git changes from the active thread worktree', async function () {
    this.timeout(60_000)
    const changesBtn = await $('#titlebar .titlebar-btn[aria-label="Open changes"]')
    await changesBtn.click()

    await browser.waitUntil(
      async () => {
        const paths = await $$('.git-change-path')
        return (await Promise.all(paths.map((path) => path.getText()))).includes('worktree-only.md')
      },
      { timeout: 30_000, timeoutMsg: 'expected the worktree-only change in the Changes pane' },
    )
    const paths = await $$('.git-change-path')
    assert.ok(!(await Promise.all(paths.map((path) => path.getText()))).includes('project-only.md'))
    await expect(changesBtn).toHaveElementClass('active')
  })
})
