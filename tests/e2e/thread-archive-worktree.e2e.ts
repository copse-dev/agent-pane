import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { e2eWorkspaceDir, resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-archive-worktree'
const CLEAN_ID = 'archive-clean'
const DIRTY_ID = 'archive-dirty'
const CLEAN_BRANCH = 'copse/archive-clean'
const DIRTY_BRANCH = 'copse/archive-dirty'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('archive chat and remove its worktree', function () {
  this.timeout(120_000)
  let projectRoot = ''
  let cleanRoot = ''
  let dirtyRoot = ''
  let cleanHead = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(dirname(worktreesRoot), 'thread-archive-project')
    cleanRoot = join(worktreesRoot, PROJECT_ID, CLEAN_ID)
    dirtyRoot = join(worktreesRoot, PROJECT_ID, DIRTY_ID)
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(join(worktreesRoot, PROJECT_ID), { recursive: true, force: true })
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    writeFileSync(join(projectRoot, 'README.md'), 'base\n')
    writeFileSync(join(projectRoot, '.gitignore'), 'local.log\n')
    git(projectRoot, ['add', '.'])
    git(projectRoot, ['commit', '-qm', 'seed'])
    const baseCommit = git(projectRoot, ['rev-parse', 'HEAD'])
    mkdirSync(dirname(cleanRoot), { recursive: true })
    git(projectRoot, ['worktree', 'add', '-b', CLEAN_BRANCH, cleanRoot, 'main'])
    git(projectRoot, ['worktree', 'add', '-b', DIRTY_BRANCH, dirtyRoot, 'main'])
    writeFileSync(join(cleanRoot, 'committed.txt'), 'unmerged work\n')
    git(cleanRoot, ['add', '.'])
    git(cleanRoot, ['commit', '-qm', 'keep committed work'])
    cleanHead = git(cleanRoot, ['rev-parse', 'HEAD'])
    writeFileSync(join(dirtyRoot, 'README.md'), 'uncommitted edit\n')
    mkdirSync(join(dirtyRoot, 'notes'))
    writeFileSync(join(dirtyRoot, 'notes/draft.txt'), 'untracked draft\n')
    writeFileSync(join(dirtyRoot, 'local.log'), 'ignored file\n')
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
      messages: [
        { id: `${id}-user`, role: 'user', content: title, toolCalls: [], createdAt: now - 1000 },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      gitBranch: branch,
      worktreeChoice: 'worktree',
      worktree: {
        path,
        branch,
        baseBranch: 'main',
        baseCommit,
        createdAt: now - 2000,
        seededFromDirtyProject: false,
      },
      createdAt: now - 2000,
      updatedAt: now - 1000,
    })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'Archive worktrees' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: 'archive-keep',
      [`threads:${PROJECT_ID}`]: [
        {
          id: 'archive-keep',
          title: 'Chat that stays',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        worktreeThread(CLEAN_ID, 'Committed work', CLEAN_BRANCH, cleanRoot),
        worktreeThread(DIRTY_ID, 'Local edits', DIRTY_BRANCH, dirtyRoot),
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

  async function archiveFromSidebar(threadId: string): Promise<void> {
    const row = $(`.chat-row[data-thread-id="${threadId}"]`)
    await row.waitForDisplayed({ timeout: 30_000 })
    await row.moveTo()
    await row.$('.chat-menu-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await $('.context-menu-item=Archive').click()
  }

  it('removes a clean checkout immediately and keeps its unmerged branch and history', async () => {
    await archiveFromSidebar(CLEAN_ID)
    await $(`.chat-row[data-thread-id="${CLEAN_ID}"]`).waitForExist({
      reverse: true,
      timeout: 10_000,
    })
    assert.equal(existsSync(cleanRoot), false)
    assert.equal(git(projectRoot, ['rev-parse', CLEAN_BRANCH]), cleanHead)
    assert.ok(existsSync(join(e2eWorkspaceDir(), PROJECT_ID, CLEAN_ID, 'events.jsonl')))
    await expect($('#confirm-dialog')).not.toBeDisplayed()
  })

  it('lists the files at risk, cancels without loss, and discards only after confirmation', async () => {
    await archiveFromSidebar(DIRTY_ID)
    const dialog = $('#confirm-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.confirm-dialog-message')).toHaveText(
      'Discard uncommitted files and archive “Local edits”?',
    )
    for (const text of [
      'README.md',
      'notes/draft.txt',
      'local.log',
      'permanently discarded',
      'committed work on its branch will be kept',
    ]) {
      await expect(dialog.$('.confirm-dialog-detail')).toHaveText(expect.stringContaining(text))
    }
    await expect(dialog.$('.confirm-dialog-confirm')).toHaveText('Discard and archive')
    await saveAppScreenshot('thread-archive-discard-confirm.png')
    await dialog.$('.confirm-dialog-cancel').click()
    await expect($(`.chat-row[data-thread-id="${DIRTY_ID}"]`)).toBeExisting()
    assert.equal(readFileSync(join(dirtyRoot, 'README.md'), 'utf8'), 'uncommitted edit\n')
    assert.equal(readFileSync(join(dirtyRoot, 'notes/draft.txt'), 'utf8'), 'untracked draft\n')
    assert.equal(readFileSync(join(dirtyRoot, 'local.log'), 'utf8'), 'ignored file\n')

    await archiveFromSidebar(DIRTY_ID)
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await dialog.$('.confirm-dialog-confirm').click()
    await $(`.chat-row[data-thread-id="${DIRTY_ID}"]`).waitForExist({
      reverse: true,
      timeout: 10_000,
    })
    assert.equal(existsSync(dirtyRoot), false)
    assert.ok(git(projectRoot, ['branch', '--list', DIRTY_BRANCH]))
    assert.ok(existsSync(join(e2eWorkspaceDir(), PROJECT_ID, DIRTY_ID, 'events.jsonl')))
    assert.equal(readFileSync(join(projectRoot, 'README.md'), 'utf8'), 'base\n')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($(`.chat-row[data-thread-id="${DIRTY_ID}"]`)).not.toBeExisting()
    await expect($(`.chat-row[data-thread-id="${CLEAN_ID}"]`)).not.toBeExisting()
  })
})
