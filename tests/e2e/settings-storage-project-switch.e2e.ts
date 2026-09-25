import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

// The Storage → Worktrees section lists checkouts for one project at a time.
// Before the picker, that project was always whichever thread the sidebar
// happened to be showing — a project you weren't looking at could not be
// inspected or cleaned up at all. This proves the picker actually switches
// the *listed* project (not just its label) and that per-row actions act on
// the project selected in the dropdown, not the active thread's project.

const PROJECT_A_ID = 'e2e-storage-picker-project-a'
const PROJECT_B_ID = 'e2e-storage-picker-project-b'
const BRANCH_A = 'copse/e2e-storage-picker-alpha'
const BRANCH_B = 'copse/e2e-storage-picker-bravo'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initProject(root: string): void {
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'e2e@example.invalid'])
  git(root, ['config', 'user.name', 'Copse E2E'])
  writeFileSync(join(root, 'README.md'), 'storage project-switch fixture\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-qm', 'seed'])
}

describe('settings → Storage → project picker', function () {
  this.timeout(120_000)
  let worktreesRoot = ''
  let projectARoot = ''
  let projectBRoot = ''
  let worktreeARoot = ''
  let worktreeBRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    const root = process.env['COPSE_WORKTREES_DIR']
    if (!root) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    worktreesRoot = root

    projectARoot = join(dirname(worktreesRoot), 'settings-storage-picker-project-a')
    projectBRoot = join(dirname(worktreesRoot), 'settings-storage-picker-project-b')
    initProject(projectARoot)
    initProject(projectBRoot)

    worktreeARoot = join(worktreesRoot, PROJECT_A_ID, 'checkout')
    worktreeBRoot = join(worktreesRoot, PROJECT_B_ID, 'checkout')
    mkdirSync(dirname(worktreeARoot), { recursive: true })
    mkdirSync(dirname(worktreeBRoot), { recursive: true })
    git(projectARoot, ['worktree', 'add', '-q', '-b', BRANCH_A, worktreeARoot])
    git(projectBRoot, ['worktree', 'add', '-q', '-b', BRANCH_B, worktreeBRoot])

    // Project A is the active project (what the sidebar/thread is showing).
    // Project B has no thread pointed at it at all — the exact case the
    // picker exists for: a project you are not "looking at".
    writeSeedConfig({
      projects: [
        { id: PROJECT_A_ID, path: projectARoot, name: 'Alpha' },
        { id: PROJECT_B_ID, path: projectBRoot, name: 'Bravo' },
      ],
      activeProjectId: PROJECT_A_ID,
    })

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    for (const [projectRoot, worktreeRoot] of [
      [projectARoot, worktreeARoot],
      [projectBRoot, worktreeBRoot],
    ]) {
      if (!projectRoot || !worktreeRoot || !existsSync(worktreeRoot)) continue
      try {
        git(projectRoot, ['worktree', 'remove', '--force', worktreeRoot])
      } catch {
        rmSync(worktreeRoot, { recursive: true, force: true })
      }
    }
    for (const root of [projectARoot, projectBRoot]) {
      if (root) rmSync(root, { recursive: true, force: true })
    }
  })

  it('defaults to the active project, switches on selection, and scopes actions to the picked project', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="storage"]').click()

    const select = $('#storage-project-select')
    await expect(select).toBeDisplayed()
    assert.equal(await select.getValue(), PROJECT_A_ID, 'defaults to the active project')
    assert.deepEqual(await select.$$('option').map((option) => option.getAttribute('value')), [
      PROJECT_A_ID,
      PROJECT_B_ID,
    ])

    const rowA = $(`.sources-row[data-worktree-path="${worktreeARoot}"]`)
    await rowA.waitForDisplayed({ timeout: 30_000 })
    await expect($$('.sources-row[data-worktree-path]')).toBeElementsArrayOfSize(1)
    await expect(rowA.$('.sources-row-title')).toHaveText(BRANCH_A)

    await saveElementScreenshot('#settings-dialog', 'settings-storage-project-a-worktrees.png')

    // Switch the picker to the project the active thread is NOT pointed at.
    await select.selectByAttribute('value', PROJECT_B_ID)
    await expect(select).toHaveValue(PROJECT_B_ID)
    await expect($('#storage-project-path')).toHaveText(projectBRoot)

    const rowB = $(`.sources-row[data-worktree-path="${worktreeBRoot}"]`)
    await rowB.waitForDisplayed({ timeout: 30_000 })
    await expect($$('.sources-row[data-worktree-path]')).toBeElementsArrayOfSize(1)
    await expect(rowB.$('.sources-row-title')).toHaveText(BRANCH_B)
    assert.equal(
      await $(`.sources-row[data-worktree-path="${worktreeARoot}"]`).isExisting(),
      false,
      'switching projects replaces the list rather than appending to it',
    )

    await saveElementScreenshot('#settings-dialog', 'settings-storage-project-b-worktrees.png')

    // Delete the checkout for the *selected* project (B), while the active
    // project remains A. If the action targeted the active thread's project
    // instead of the picker, this would either fail or delete A's checkout.
    await rowB.$('.sources-worktree-delete-btn').click()
    const confirm = $('#confirm-dialog')
    await confirm.waitForDisplayed({ timeout: 30_000 })
    await expect(confirm.$('.confirm-dialog-message')).toHaveText(`Delete worktree ${BRANCH_B}?`)
    await confirm.$('.confirm-dialog-confirm').click()
    await expect($('#sources-worktrees-list')).toHaveText(expect.stringContaining('No worktrees'))
    assert.equal(existsSync(worktreeBRoot), false, 'the selected project’s checkout was removed')
    assert.equal(existsSync(worktreeARoot), true, 'the active project’s checkout was untouched')

    // Switching back to A shows its checkout is still there, confirming the
    // delete above never touched it.
    await select.selectByAttribute('value', PROJECT_A_ID)
    await rowA.waitForDisplayed({ timeout: 30_000 })
    await expect(rowA.$('.sources-row-title')).toHaveText(BRANCH_A)
  })
})
