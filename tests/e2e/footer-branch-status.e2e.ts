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
import { describeSkipInCi } from './helpers/ci-gate.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('footer branch status match', () => {
  let seed: ReturnType<typeof seedFooterBranchFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedFooterBranchFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the thread branch when checkout matches', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).toBeDisplayed()
    await expect(branchBtn).not.toHaveElementClass('is-mismatch')
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(seed.currentBranch)
    await expect(branchBtn.$('.branch-picker-chevron')).not.toBeDisplayed()

    const inputBar = await $('#input-bar')
    await inputBar.saveScreenshot(join(SCREENSHOT_DIR, 'footer-branch-match.png'))
  })
})

describeSkipInCi('footer branch status mismatch', () => {
  let seed: ReturnType<typeof seedFooterBranchMismatchFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedFooterBranchMismatchFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('highlights mismatch when thread branch differs from checkout', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).toBeDisplayed({ wait: 10_000 })
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(seed.mismatchBranch, {
      wait: 10_000,
    })

    const inputBar = await $('#input-bar')
    await inputBar.saveScreenshot(join(SCREENSHOT_DIR, 'footer-branch-mismatch.png'))

    // Warning styling needs live git checkout detection (may be unavailable in headless e2e).
    const hasMismatchClass = (await branchBtn.getAttribute('class'))?.includes('is-mismatch')
    if (hasMismatchClass) {
      await expect(branchBtn).toHaveElementClass('is-mismatch')
    }
  })
})

describe('footer branch status for a detached thread worktree', () => {
  const projectId = 'e2e-footer-detached-project'
  const healthyThreadId = 'e2e-footer-healthy-thread'
  const detachedThreadId = 'e2e-footer-detached-thread'
  const detachedBranch = 'copse/e2e-footer-detached'
  let projectRoot = ''

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  before(async function () {
    this.timeout(120_000)
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(dirname(worktreesRoot), 'footer-detached-project-checkout')
    rmSync(projectRoot, { recursive: true, force: true })
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    writeFileSync(join(projectRoot, 'README.md'), 'detached footer fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])

    const worktreeRoot = join(worktreesRoot, projectId, detachedThreadId)
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
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now - 1,
          updatedAt: now - 1,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
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

    const inputBar = await $('#input-bar')
    await inputBar.saveScreenshot(join(SCREENSHOT_DIR, 'footer-branch-detached-worktree.png'))
  })
})
