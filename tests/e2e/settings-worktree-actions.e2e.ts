import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-settings-worktree-actions-project'
const THREAD_ID = 'e2e-settings-worktree-actions-thread'
const WORKTREE_BRANCH =
  'copse/e2e-settings-worktree-actions-with-a-deliberately-long-name-for-hover-layout'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('settings → Storage → worktree actions', function () {
  this.timeout(120_000)
  let projectRoot = ''
  let worktreeRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(dirname(worktreesRoot), 'settings-worktree-actions-project')
    worktreeRoot = join(worktreesRoot, PROJECT_ID, THREAD_ID)
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n.venv/\n')
    writeFileSync(join(projectRoot, 'README.md'), 'worktree settings actions fixture\n')
    git(projectRoot, ['add', '.gitignore', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])

    mkdirSync(dirname(worktreeRoot), { recursive: true })
    const baseCommit = git(projectRoot, ['rev-parse', 'HEAD'])
    git(projectRoot, ['worktree', 'add', '-q', '-b', WORKTREE_BRANCH, worktreeRoot])
    mkdirSync(join(worktreeRoot, 'node_modules', 'example-package'), { recursive: true })
    writeFileSync(
      join(worktreeRoot, 'node_modules', 'example-package', 'index.js'),
      'module.exports = true\n'.repeat(200),
    )
    writeFileSync(join(worktreeRoot, 'draft.txt'), 'uncommitted work\n')

    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'Worktree actions' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Dependency cleanup demo',
          status: 'idle',
          messages: [],
          draftPrompt: 'keep fixture thread',
          usage: { inputTokens: 0, outputTokens: 0 },
          gitBranch: WORKTREE_BRANCH,
          worktreeChoice: 'worktree',
          worktree: {
            path: worktreeRoot,
            branch: WORKTREE_BRANCH,
            baseBranch: 'main',
            baseCommit,
            createdAt: now - 60 * 60 * 1000,
            seededFromDirtyProject: false,
          },
          createdAt: now - 60 * 60 * 1000,
          updatedAt: now - 15 * 60 * 1000,
        },
      ],
    })

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (projectRoot && worktreeRoot && existsSync(worktreeRoot)) {
      try {
        git(projectRoot, ['worktree', 'remove', '--force', worktreeRoot])
      } catch {
        rmSync(worktreeRoot, { recursive: true, force: true })
      }
    }
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('shows thread, terminal, and package cleanup actions', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="storage"]').click()

    const row = $(`.sources-row[data-worktree-path="${worktreeRoot}"]`)
    await row.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(
      async () => (await row.$('.sources-worktree-size').getText()) !== 'sizing…',
    )

    const thread = row.$('.sources-worktree-thread-btn')
    await expect(thread).toHaveText('thread')
    await expect(thread).toHaveAttribute('aria-label', 'Open thread Dependency cleanup demo')
    await expect(row.$('.sources-worktree-terminal-btn')).toBeClickable()
    await expect(row.$('.sources-worktree-cleanup-btn')).toBeClickable()
    await expect(row.$('.sources-worktree-delete-btn')).toBeClickable()

    const heightAtRest = await row.getSize('height')
    await row.moveTo()
    await browser.pause(50)
    const heightOnHover = await row.getSize('height')
    assert.equal(heightOnHover, heightAtRest, 'hover must not change the worktree row height')
    assert.equal((await row.$('.sources-row-title').getCSSProperty('white-space')).value, 'nowrap')

    await saveElementScreenshot('#settings-dialog', 'settings-worktree-actions.png')

    await row.$('.sources-worktree-terminal-btn').click()
    await expect($('#sources-worktrees-status')).toHaveText(
      expect.stringContaining('Opened a terminal'),
    )

    await row.$('.sources-worktree-cleanup-btn').click()
    const confirm = $('#confirm-dialog')
    await confirm.waitForDisplayed({ timeout: 30_000 })
    await expect(confirm.$('.confirm-dialog-message')).toHaveText('Remove 1 package directory?')
    await expect(confirm.$('.confirm-dialog-detail')).toHaveText(
      expect.stringContaining('node_modules'),
    )
    await saveAppScreenshot('settings-worktree-cleanup-confirm.png')
    await confirm.$('.confirm-dialog-cancel').click()

    await thread.click()
    await expect($('#settings-dialog')).not.toBeDisplayed()
    await expect($(`.chat-row[data-thread-id="${THREAD_ID}"]`)).toHaveElementClass('selected')
    assert.equal(existsSync(join(worktreeRoot, 'node_modules')), true, 'cancel keeps dependencies')
  })
})
