import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { e2eWorkspaceDir, resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-delete-worktree-project'
const KEEP_THREAD_ID = 'e2e-thread-delete-worktree-keep'
const CLEAN_THREAD_ID = 'e2e-thread-delete-worktree-clean'
const DIRTY_THREAD_ID = 'e2e-thread-delete-worktree-dirty'
const CLEAN_BRANCH = 'copse/e2e-thread-delete-clean'
const DIRTY_BRANCH = 'copse/e2e-thread-delete-dirty'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function registeredWorktrees(projectRoot: string): string[] {
  return git(projectRoot, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

/**
 * Deleting a thread from the sidebar retires its linked checkout only when that
 * loses nothing. A clean checkout on a merged branch disappears with the thread;
 * one holding uncommitted work stays on disk and is left for Settings → Storage
 * → Worktrees, where removing it takes an explicit confirmation.
 */
describe('thread deletion → worktree retirement', function () {
  this.timeout(120_000)
  let projectRoot = ''
  let cleanRoot = ''
  let dirtyRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(dirname(worktreesRoot), 'thread-delete-worktree-project')
    cleanRoot = join(worktreesRoot, PROJECT_ID, CLEAN_THREAD_ID)
    dirtyRoot = join(worktreesRoot, PROJECT_ID, DIRTY_THREAD_ID)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(join(worktreesRoot, PROJECT_ID), { recursive: true, force: true })
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    writeFileSync(join(projectRoot, 'README.md'), 'thread deletion worktree fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])
    const baseCommit = git(projectRoot, ['rev-parse', 'HEAD'])

    mkdirSync(join(worktreesRoot, PROJECT_ID), { recursive: true })
    git(projectRoot, ['worktree', 'add', '-q', '-b', CLEAN_BRANCH, cleanRoot])
    git(projectRoot, ['worktree', 'add', '-q', '-b', DIRTY_BRANCH, dirtyRoot])
    writeFileSync(join(dirtyRoot, 'draft.txt'), 'uncommitted work\n')

    const now = Date.now()
    const worktreeThread = (
      id: string,
      title: string,
      branch: string,
      path: string,
    ): Record<string, unknown> => ({
      id,
      title,
      status: 'idle',
      // A worktree is cut by a thread's first message, so these threads have
      // one. Blank threads are pruned from the sidebar on load.
      messages: [
        { id: `${id}-user`, role: 'user', content: title, createdAt: now - 45 * 60 * 1000 },
        {
          id: `${id}-assistant`,
          role: 'assistant',
          content: `Done: ${title.toLowerCase()}.`,
          createdAt: now - 44 * 60 * 1000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      gitBranch: branch,
      worktreeChoice: 'worktree',
      worktree: {
        path,
        branch,
        baseBranch: 'main',
        baseCommit,
        createdAt: now - 60 * 60 * 1000,
        seededFromDirtyProject: false,
      },
      createdAt: now - 60 * 60 * 1000,
      updatedAt: now - 30 * 60 * 1000,
    })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'Thread deletion' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: KEEP_THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: KEEP_THREAD_ID,
          title: 'Thread that stays',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        worktreeThread(CLEAN_THREAD_ID, 'Clean merged work', CLEAN_BRANCH, cleanRoot),
        worktreeThread(DIRTY_THREAD_ID, 'Unsaved draft work', DIRTY_BRANCH, dirtyRoot),
      ],
    })

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    for (const path of [cleanRoot, dirtyRoot]) {
      if (!projectRoot || !path || !existsSync(path)) continue
      try {
        git(projectRoot, ['worktree', 'remove', '--force', path])
      } catch {
        rmSync(path, { recursive: true, force: true })
      }
    }
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
  })

  async function deleteFromSidebar(threadId: string): Promise<void> {
    const row = $(`.chat-row[data-thread-id="${threadId}"]`)
    await row.waitForDisplayed({ timeout: 30_000 })
    // The delete control only appears on hover, as it does for a person.
    await row.moveTo()
    const del = row.$('.chat-delete')
    await del.waitForDisplayed({ timeout: 5_000 })
    await del.click()
    await row.waitForExist({ reverse: true, timeout: 10_000 })
  }

  it('removes the clean worktree and keeps the dirty one for Settings', async () => {
    for (const threadId of [KEEP_THREAD_ID, CLEAN_THREAD_ID, DIRTY_THREAD_ID]) {
      await $(`.chat-row[data-thread-id="${threadId}"]`).waitForDisplayed({ timeout: 30_000 })
    }
    await expect($$('.chat-row[data-thread-id]')).toBeElementsArrayOfSize(3)
    assert.ok(registeredWorktrees(projectRoot).includes(cleanRoot))
    assert.ok(registeredWorktrees(projectRoot).includes(dirtyRoot))

    await deleteFromSidebar(CLEAN_THREAD_ID)
    await deleteFromSidebar(DIRTY_THREAD_ID)

    // Main-process deletion runs behind the renderer's persistence queue.
    await browser.waitUntil(() => !existsSync(cleanRoot), {
      timeout: 30_000,
      timeoutMsg: 'expected the clean thread worktree to be removed',
    })
    const workspaceDir = e2eWorkspaceDir()
    await browser.waitUntil(() => !existsSync(join(workspaceDir, PROJECT_ID, DIRTY_THREAD_ID)), {
      timeout: 30_000,
      timeoutMsg: 'expected the dirty thread itself to be deleted',
    })

    const registered = registeredWorktrees(projectRoot)
    assert.ok(!registered.includes(cleanRoot), 'git no longer lists the clean worktree')
    assert.equal(git(projectRoot, ['branch', '--list', CLEAN_BRANCH]), '')
    assert.ok(registered.includes(dirtyRoot), 'git still lists the dirty worktree')
    assert.equal(readFileSync(join(dirtyRoot, 'draft.txt'), 'utf8'), 'uncommitted work\n')
    assert.notEqual(git(projectRoot, ['branch', '--list', DIRTY_BRANCH]), '')
    assert.ok(existsSync(join(workspaceDir, PROJECT_ID, KEEP_THREAD_ID)))

    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="storage"]').click()
    const row = $(`.sources-row[data-worktree-path="${dirtyRoot}"]`)
    await row.waitForDisplayed({ timeout: 30_000 })
    await expect($$('.sources-row[data-worktree-path]')).toBeElementsArrayOfSize(1)
    await expect($(`.sources-row[data-worktree-path="${cleanRoot}"]`)).not.toExist()
    await expect(row).toHaveText(expect.stringContaining('No thread on record'))
    await expect(row.$('.sources-worktree-changes')).toHaveText(/1 uncommitted/i)
    await expect(row.$('.sources-worktree-delete-btn')).toBeClickable()
    await browser.waitUntil(
      async () => (await row.$('.sources-worktree-size').getText()) !== 'sizing…',
    )

    // Crop to the list: the dialog header shows this run's absolute profile path.
    await saveElementScreenshot(
      '.sources-worktrees-fieldset',
      'thread-delete-worktree-settings.png',
    )
  })
})
