import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-base-branch-project'
const THREAD = 'e2e-base-branch-thread'
const BRANCH = 'copse/recover-checkout'
const PROMPT = 'Inspect this checkout without editing the base branch.'

describe('a thread checkout accidentally on its base branch', () => {
  let projectRoot = ''
  let worktreeRoot = ''
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  before(async () => {
    resetUserData()
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    const root = process.env['COPSE_WORKTREES_DIR']
    if (!root) throw new Error('Missing isolated e2e worktrees root')
    projectRoot = join(dirname(root), 'workspace')
    worktreeRoot = join(root, PROJECT, THREAD)
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(dirname(worktreeRoot), { recursive: true })
    git(projectRoot, 'init', '-q', '-b', 'main')
    git(projectRoot, 'config', 'user.name', 'Copse E2E')
    git(projectRoot, 'config', 'user.email', 'e2e@example.invalid')
    git(projectRoot, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(projectRoot, 'README.md'), '# Checkout recovery\n')
    git(projectRoot, 'add', 'README.md')
    git(projectRoot, 'commit', '-qm', 'baseline')
    const baseCommit = git(projectRoot, 'rev-parse', 'HEAD')
    git(projectRoot, 'worktree', 'add', '-q', '-b', BRANCH, worktreeRoot)
    // Git permits the mistake only after the project checkout releases main.
    git(projectRoot, 'checkout', '-qb', 'project-work')
    git(worktreeRoot, 'checkout', '-q', 'main')
    const now = 1767225600000
    writeSeedConfig({
      projects: [{ id: PROJECT, path: projectRoot, name: 'workspace' }],
      activeProjectId: PROJECT,
      activeThreadId: THREAD,
      expandedProjectId: PROJECT,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Recover the thread checkout',
          status: 'idle',
          messages: [
            {
              id: 'checkout-request',
              role: 'user',
              content: PROMPT,
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          gitBranch: BRANCH,
          worktreeChoice: 'worktree',
          worktree: {
            path: worktreeRoot,
            branch: BRANCH,
            baseBranch: 'main',
            baseCommit,
            createdAt: now,
            seededFromDirtyProject: false,
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    writeSettings({ model: 'claude-sonnet-4-6' })
    await browser.reloadSession()
    await $('[data-message-id="checkout-request"]').waitForDisplayed({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
    if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true })
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('refuses the agent run and explains how to return to the thread branch', async () => {
    // Exercise the native dispatch boundary directly: composer checkout
    // preparation has its own earlier refusal and is not this error surface.
    await browser.execute(
      async ({ project, thread, prompt }) => {
        await window.api.agent.run(project, thread, prompt)
      },
      { project: PROJECT, thread: THREAD, prompt: PROMPT },
    )
    const text = $('.msg-assistant .message-text')
    await expect(text).toHaveText(expect.stringContaining('checkout is on its base branch'))
    await expect(text).toHaveText(expect.stringContaining(`git checkout ${BRANCH}`))
    await expect(text).toHaveText(expect.stringContaining('Your files are preserved.'))
    await expect($('.toast-error')).not.toExist()
    await expect($('.apple-development-error')).not.toExist()
    expect(git(worktreeRoot, 'branch', '--show-current')).toBe('main')
    expect(git(worktreeRoot, 'status', '--porcelain')).toBe('')
    // Assert the real path before pinning the isolated profile prefix for pixels.
    await expect(text).toHaveText(expect.stringContaining(worktreeRoot))
    const pathPattern = new RegExp(worktreeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    const restore = await pinTextForCapture(
      '.msg-assistant .message-text',
      pathPattern,
      '/workspace/thread-checkout',
    )
    try {
      await saveAppScreenshot('thread-worktree-base-branch.png')
    } finally {
      await restore()
    }
  })
})
