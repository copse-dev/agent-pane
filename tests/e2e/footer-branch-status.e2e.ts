import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedFooterBranchFixture,
  seedFooterBranchMismatchFixture,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { seedBranchWorkspace } from './helpers/branch-workspace.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('footer branch status match', () => {
  let seed: ReturnType<typeof seedFooterBranchFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedFooterBranchFixture(seedBranchWorkspace())
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
  })

  it('shows the thread branch when checkout matches', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).toBeDisplayed()
    await expect(branchBtn).not.toHaveElementClass('is-mismatch')
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(seed.currentBranch)
    await expect(branchBtn.$('.branch-picker-chevron')).not.toBeDisplayed()

    await saveElementScreenshot('#input-bar', 'footer-branch-match.png')
  })
})

describe('footer branch status mismatch', () => {
  let seed: ReturnType<typeof seedFooterBranchMismatchFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedFooterBranchMismatchFixture(seedBranchWorkspace())
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
  })

  it('highlights mismatch when thread branch differs from checkout', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).toBeDisplayed({ wait: 10_000 })
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(seed.mismatchBranch, {
      wait: 10_000,
    })

    await expect(branchBtn).toHaveElementClass('is-mismatch')
    await saveElementScreenshot('#input-bar', 'footer-branch-mismatch.png')
  })
})

describe('footer branch status for a detached thread worktree', () => {
  const projectId = 'e2e-footer-detached-project'
  const healthyThreadId = 'e2e-footer-healthy-thread'
  const detachedThreadId = 'e2e-footer-detached-thread'
  const detachedBranch = 'copse/e2e-footer-detached'
  let projectRoot = ''
  let worktreeRoot = ''

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  /** The repair button shares the branch's line instead of wrapping beneath it. */
  async function expectOnBranchLine(button: WebdriverIO.Element): Promise<void> {
    const label = await $('.footer-branch-status').getLocation()
    const labelSize = await $('.footer-branch-status').getSize()
    const buttonAt = await button.getLocation()
    const buttonSize = await button.getSize()
    const labelMid = label.y + labelSize.height / 2
    const buttonMid = buttonAt.y + buttonSize.height / 2
    expect(Math.abs(labelMid - buttonMid)).toBeLessThan(2)
    expect(buttonAt.x).toBeGreaterThan(label.x + labelSize.width - 1)
  }

  before(async function () {
    this.timeout(120_000)
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: undefined })

    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(dirname(worktreesRoot), 'footer-detached-project-checkout')
    rmSync(projectRoot, { recursive: true, force: true })
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    git(projectRoot, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(projectRoot, 'README.md'), 'detached footer fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])

    worktreeRoot = join(worktreesRoot, projectId, detachedThreadId)
    mkdirSync(dirname(worktreeRoot), { recursive: true })
    const baseBranch = git(projectRoot, ['branch', '--show-current'])
    const baseCommit = git(projectRoot, ['rev-parse', 'HEAD'])
    git(projectRoot, ['worktree', 'add', '-q', '-b', detachedBranch, worktreeRoot])
    git(worktreeRoot, ['checkout', '--detach', '-q'])

    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, path: projectRoot, name: 'workspace' }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: healthyThreadId,
      [`threads:${projectId}`]: [
        {
          id: healthyThreadId,
          title: 'Healthy thread',
          status: 'idle',
          gitBranch: baseBranch,
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: detachedThreadId,
          title: 'Detached worktree thread',
          status: 'idle',
          gitBranch: detachedBranch,
          worktreeChoice: 'worktree',
          worktree: {
            path: worktreeRoot,
            branch: detachedBranch,
            baseBranch,
            baseCommit,
            createdAt: now,
            seededFromDirtyProject: false,
          },
          // Keep this distinct from the active blank composer: restore
          // intentionally collapses surplus unused blank threads.
          messages: [
            {
              id: 'msg-user-detached',
              role: 'user',
              content: 'Inspect this detached worktree.',
              toolCalls: [],
              createdAt: now - 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now - 1,
          updatedAt: now - 1,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
    // Reclaim the checkout *and* its worktree: e2e containers are reused, and a
    // worktree orphaned by deleting its repository outlives the spec otherwise.
    if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true })
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('switches threads without showing an unexpected-error toast', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(`[data-thread-id="${detachedThreadId}"]`).click()
    await expect($(`[data-thread-id="${detachedThreadId}"]`)).toHaveElementClass('selected')

    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).toBeDisplayed()
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(detachedBranch)
    await expect($('.toast-error')).not.toExist()
    await expect(branchBtn).toHaveElementClass('is-detached')
    const reattachBtn = await $('.branch-reattach-button')
    await expect(reattachBtn).toBeDisplayed()
    await expect(reattachBtn).toBeEnabled()
    await expect(reattachBtn).toHaveAttribute(
      'aria-label',
      `Reattach checkout to ${detachedBranch}`,
    )
    await expectOnBranchLine(reattachBtn)

    await saveElementScreenshot('#input-bar', 'footer-branch-detached-worktree.png')
  })

  it('reattaches the checkout to its branch from the footer', async () => {
    await $('.branch-reattach-button').click()

    await expect($('.branch-reattach-button')).not.toBeDisplayed({ wait: 10_000 })
    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).not.toHaveElementClass('is-detached')
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(detachedBranch)
    await expect($('.toast-error')).not.toExist()
    // The repair is real: Git itself reports the checkout back on the branch.
    expect(git(worktreeRoot, ['symbolic-ref', '--short', 'HEAD'])).toBe(detachedBranch)

    await saveElementScreenshot('#input-bar', 'footer-branch-reattached-worktree.png')
  })

  it('offers to continue a rebase that stopped part-way', async function () {
    this.timeout(90_000)
    // A conflicting rebase stops with HEAD detached and its sequencer state on
    // disk: the state a signing failure or conflict leaves an agent's checkout in.
    const baseBranch = git(projectRoot, ['branch', '--show-current'])
    writeFileSync(join(worktreeRoot, 'README.md'), 'thread change\n')
    git(worktreeRoot, ['commit', '-qam', 'thread change'])
    writeFileSync(join(projectRoot, 'README.md'), 'base change\n')
    git(projectRoot, ['commit', '-qam', 'base change'])
    expect(() => git(worktreeRoot, ['rebase', baseBranch])).toThrow()
    expect(git(worktreeRoot, ['status'])).toContain('rebase in progress')

    // The rebase rewrote the checkout's files, and the footer's working-tree
    // watcher picks that up without a thread switch.
    const continueBtn = await $('.branch-reattach-button')
    await expect(continueBtn).toHaveText('Continue rebase', { wait: 20_000 })
    await expect(continueBtn).toBeEnabled()
    await expect(continueBtn).toHaveAttribute(
      'aria-label',
      `Continue the rebase on ${detachedBranch} in a terminal`,
    )
    await expectOnBranchLine(continueBtn)

    await saveElementScreenshot('#input-bar', 'footer-branch-rebase-in-progress.png')

    // Resolve the conflict, then let the same background shell finish the
    // rebase. The completion event should start a machine-originated turn.
    writeFileSync(join(worktreeRoot, 'README.md'), 'resolved thread change\n')
    git(worktreeRoot, ['add', 'README.md'])
    git(worktreeRoot, ['config', 'core.editor', 'true'])
    await installMockScenario({
      title: 'Continue after Git recovery',
      turns: [
        {
          user: { includes: 'Continue after the Git recovery command completed.' },
          responses: [{ text: 'The recovery completed; continuing the task.' }],
        },
      ],
    })
    await continueBtn.click()
    await approveUnsandboxedTerminalIfPrompted()
    await expect($('.branch-reattach-button')).not.toBeDisplayed({ wait: 30_000 })
    await expect($('.msg-machine-origin')).toBeDisplayed({ wait: 30_000 })
    await saveElementScreenshot('#conversation', 'footer-branch-recovery-continued.png')
  })

  it('commits a pick that failed to sign before continuing the rebase', async function () {
    this.timeout(90_000)
    // Start from main so the conflicting commit from the previous case does
    // not stop this rebase first. The previous case may have completed it.
    if (git(worktreeRoot, ['status']).includes('rebase in progress')) {
      git(worktreeRoot, ['rebase', '--abort'])
    }
    const baseBranch = git(projectRoot, ['branch', '--show-current'])
    git(worktreeRoot, ['reset', '-q', '--hard', baseBranch])
    writeFileSync(join(worktreeRoot, 'thread.txt'), 'thread\n')
    git(worktreeRoot, ['add', 'thread.txt'])
    git(worktreeRoot, ['commit', '-qm', 'thread file'])
    const picked = git(worktreeRoot, ['rev-parse', 'HEAD'])
    writeFileSync(join(projectRoot, 'main.txt'), 'main\n')
    git(projectRoot, ['add', 'main.txt'])
    git(projectRoot, ['commit', '-qm', 'main file'])
    // A signing key that cannot load fails the pick's commit the way a
    // sandboxed agent without the user's ssh-agent does.
    expect(() =>
      git(worktreeRoot, [
        '-c',
        'gpg.format=ssh',
        '-c',
        'user.signingkey=/nonexistent/copse-e2e-key',
        'rebase',
        '-S',
        baseBranch,
      ]),
    ).toThrow()

    const button = await $('.branch-reattach-button')
    await expect(button).toHaveText('Commit and continue', { wait: 20_000 })
    await expect(button).toBeEnabled()
    await expect(button).toHaveAttribute('title', expect.stringContaining(picked.slice(0, 7)))
    await expectOnBranchLine(button)

    await saveElementScreenshot('#input-bar', 'footer-branch-uncommitted-pick.png')

    const signingKey = join(worktreeRoot, 'copse-e2e-signing-key')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey], {
      encoding: 'utf8',
    })
    git(worktreeRoot, ['config', 'gpg.format', 'ssh'])
    git(worktreeRoot, ['config', 'user.signingkey', signingKey])
    git(worktreeRoot, ['config', 'core.editor', 'true'])
    await installMockScenario({
      title: 'Continue after Git recovery',
      turns: [
        {
          user: { includes: 'Continue after the Git recovery command completed.' },
          responses: [{ text: 'The recovery completed; continuing the task.' }],
        },
      ],
    })
    await button.click()
    await approveUnsandboxedTerminalIfPrompted()
    await expect($('.branch-reattach-button')).not.toBeDisplayed({ wait: 30_000 })
    await expect($('.msg-machine-origin')).toBeDisplayed({ wait: 30_000 })
    await saveElementScreenshot('#conversation', 'footer-branch-commit-and-continue.png')
  })

  it('offers to reset an active bisect without stranding it', async function () {
    this.timeout(90_000)
    if (git(worktreeRoot, ['status']).includes('rebase in progress')) {
      git(worktreeRoot, ['rebase', '--abort'])
    }
    const baseBranch = git(projectRoot, ['branch', '--show-current'])
    git(worktreeRoot, ['reset', '-q', '--hard', baseBranch])
    git(worktreeRoot, ['bisect', 'start', 'HEAD', 'HEAD~2'])
    expect(git(worktreeRoot, ['branch', '--show-current'])).toBe('')

    const button = await $('.branch-reattach-button')
    await expect(button).toHaveText('Reset bisect', { wait: 20_000 })
    await expect(button).toBeEnabled()
    await expect(button).toHaveAttribute(
      'aria-label',
      `Reset the bisect and return to ${detachedBranch} in a terminal`,
    )
    await expectOnBranchLine(button)

    await saveElementScreenshot('#input-bar', 'footer-branch-bisect-in-progress.png')
  })
})
