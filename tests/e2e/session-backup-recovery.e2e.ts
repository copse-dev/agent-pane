import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

let root = ''
const userDraft = 'user draft before Copse\n'
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

async function saveSettledChangesScreenshot(
  name: string,
  paths: string[],
  draft: string,
  proposed = false,
): Promise<void> {
  await expect($('.messages-list .tool-card[data-status="running"]')).not.toExist()
  await $('#git-changes-host [aria-label="Refresh changes"]').click()
  await browser.waitUntil(
    async () => {
      // A refresh can replace every row. Read one coherent DOM snapshot rather
      // than holding WebDriver elements across separate text round trips.
      const rendered = await browser.execute(() =>
        [...document.querySelectorAll('#git-changes-host .git-change-row .git-change-path')].map(
          (path) => path.textContent.trim(),
        ),
      )
      return JSON.stringify(rendered.sort()) === JSON.stringify([...paths].sort())
    },
    { timeout: 15_000, timeoutMsg: 'Changes did not settle to the fixture files' },
  )
  const row = proposed
    ? 'contains(@class,"git-change-row-proposed")'
    : 'contains(@class,"git-change-row") and not(contains(@class,"git-change-row-proposed"))'
  await $(
    `//*[@id="git-changes-host"]//button[${row}]/span[contains(@class,"git-change-path") and text()="draft.txt"]`,
  ).click()
  await browser.waitUntil(async () => (await $('.monaco-diff-editor').getText()).includes(draft), {
    timeout: 10_000,
    timeoutMsg: 'The diff did not show the expected draft',
  })
  await saveAppScreenshot(name)
}

describe('restore user work after a follow-up and restart', function () {
  this.timeout(120_000)
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-session-backup-recovery-'))
    git('init', '-b', 'main')
    writeFileSync(join(root, 'draft.txt'), 'committed baseline\n')
    writeFileSync(join(root, 'notes.txt'), 'baseline notes\n')
    git('add', '.')
    git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@copse.invalid',
      'commit',
      '-m',
      'Synthetic baseline',
    )
    writeFileSync(join(root, 'draft.txt'), userDraft)
    writeFileSync(join(root, 'notes.txt'), 'staged user notes\n')
    git('add', 'notes.txt')
    writeFileSync(join(root, 'untracked.txt'), 'untracked user draft\n')
    resetUserData()
    seedEmptyProject(root, 'e2e-session-backup-recovery', { subagentsEnabled: false })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    if (root) removeE2eTree(root)
  })

  it('keeps the latest restore point through a read-only turn and native restart, preserving the Git index', async () => {
    const index = git('ls-files', '--stage')
    const scenario = await installMockScenario({
      title: 'Repair a user draft',
      turns: [
        {
          user: 'Repair this draft.',
          responses: [
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'draft.txt', content: 'Copse repair\n' } },
              ],
            },
            { text: 'Repaired the draft with a backup.' },
          ],
        },
        {
          user: 'Explain what changed without editing.',
          responses: [
            { toolCalls: [{ name: 'read_file', args: { path: 'draft.txt' } }] },
            { text: 'Only the draft was repaired.' },
          ],
        },
      ],
    })
    await setComposerValue('Repair this draft.')
    await submitComposer()
    await scenario.waitForTurns(1)
    await waitForAgentIdle(30_000)
    assert.equal(readFileSync(join(root, 'draft.txt'), 'utf8'), 'Copse repair\n')
    await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('.git-changes-restore-btn')).toBeDisplayed()
    await setComposerValue('Explain what changed without editing.')
    await submitComposer()
    await scenario.waitForComplete()
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
    await expect($('.git-changes-restore-btn')).toBeDisplayed()
    await saveSettledChangesScreenshot(
      'session-backup-after-followup.png',
      ['draft.txt', 'notes.txt', 'untracked.txt'],
      'Copse repair',
    )

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    if (!(await $('#git-changes-host').isDisplayed()))
      await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('.git-changes-restore-btn')).toBeDisplayed()
    const geometry = await browser.execute(() => {
      const banner = document.querySelector('.git-changes-restore')?.getBoundingClientRect()
      const button = document.querySelector('.git-changes-restore-btn')?.getBoundingClientRect()
      return banner && button
        ? {
            left: button.left >= banner.left,
            right: button.right <= banner.right,
            top: button.top >= banner.top,
            bottom: button.bottom <= banner.bottom,
          }
        : null
    })
    assert.deepEqual(
      geometry,
      { left: true, right: true, top: true, bottom: true },
      'restore must fit inside a narrow Changes pane',
    )
    await saveSettledChangesScreenshot(
      'session-backup-after-restart.png',
      ['draft.txt', 'notes.txt', 'untracked.txt'],
      'Copse repair',
    )
    await $('.git-changes-restore-btn').click()
    await expect($('#confirm-dialog')).toBeDisplayed()
    await expect($('.confirm-dialog-confirm')).toHaveText('Restore')
    await $('.confirm-dialog-confirm').click()
    await browser.waitUntil(
      async () => readFileSync(join(root, 'draft.txt'), 'utf8') === userDraft,
      { timeout: 10_000, timeoutMsg: 'the pre-agent user draft was not restored' },
    )
    assert.equal(git('ls-files', '--stage'), index)
    assert.equal(readFileSync(join(root, 'untracked.txt'), 'utf8'), 'untracked user draft\n')
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'staged user notes\n')
    await expect($('.git-changes-restore-btn')).toBeEnabled()
    await saveSettledChangesScreenshot(
      'session-backup-restored.png',
      ['draft.txt', 'notes.txt', 'untracked.txt'],
      userDraft.trim(),
    )
  })

  it('refreshes before a later edit to the same already-owned file', async () => {
    const scenario = await installMockScenario({
      title: 'Refine the repaired draft',
      turns: [
        {
          user: 'Repair the draft again.',
          responses: [
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'draft.txt', content: 'First repair\n' } },
              ],
            },
            { text: 'First repair complete.' },
          ],
        },
        {
          user: 'Refine that same draft.',
          responses: [
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'draft.txt', content: 'Second repair\n' } },
              ],
            },
            { text: 'Second repair complete.' },
          ],
        },
      ],
    })
    await setComposerValue('Repair the draft again.')
    await submitComposer()
    await scenario.waitForTurns(1)
    await waitForAgentIdle(30_000)
    await setComposerValue('Refine that same draft.')
    await submitComposer()
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await waitForAgentIdle(30_000)
    assert.equal(readFileSync(join(root, 'draft.txt'), 'utf8'), 'Second repair\n')
    await $('.git-changes-restore-btn').click()
    await expect($('#confirm-dialog')).toBeDisplayed()
    await $('.confirm-dialog-confirm').click()
    await browser.waitUntil(
      async () => readFileSync(join(root, 'draft.txt'), 'utf8') === 'First repair\n',
      { timeout: 10_000, timeoutMsg: 'Restore skipped the immediately preceding edit turn' },
    )
    await expect($('.git-changes-restore-btn')).toBeEnabled()
    await saveSettledChangesScreenshot(
      'session-backup-latest-edit-restored.png',
      ['draft.txt', 'notes.txt', 'untracked.txt'],
      'First repair',
    )
  })

  it('retires an obsolete dirty pointer after committing and keeps the clean Git baseline', async () => {
    git('add', '.')
    git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@copse.invalid',
      'commit',
      '-m',
      'Keep the repaired draft',
    )
    const head = git('rev-parse', 'HEAD')
    const refs = git('for-each-ref', '--format=%(refname)', 'refs/copse/backups/')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const scenario = await installMockScenario({
      title: 'Edit the clean baseline',
      turns: [
        {
          user: 'Add a file to the committed repair.',
          responses: [
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'new-file.txt', content: 'New file\n' } },
              ],
            },
            { text: 'Added the new file.' },
          ],
        },
        {
          user: 'Improve the committed draft.',
          responses: [
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'draft.txt', content: 'Next edit\n' } },
              ],
            },
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'draft.txt', content: 'Refined edit\n' } },
              ],
            },
            { text: 'Improved the clean baseline.' },
          ],
        },
      ],
    })
    await setComposerValue('Add a file to the committed repair.')
    await submitComposer()
    await scenario.waitForTurns(1)
    await waitForAgentIdle(30_000)
    if (!(await $('#git-changes-host').isDisplayed()))
      await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('.git-changes-restore-btn')).not.toBeDisplayed()
    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/copse/backups/'), refs)
    await setComposerValue('Improve the committed draft.')
    await submitComposer()
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await waitForAgentIdle(30_000)
    assert.equal(readFileSync(join(root, 'draft.txt'), 'utf8'), 'Refined edit\n')
    assert.equal(git('rev-parse', 'HEAD'), head)
    assert.equal(git('show', 'HEAD:draft.txt'), 'First repair')
    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/copse/backups/'), refs)
    if (!(await $('#git-changes-host').isDisplayed()))
      await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('.git-changes-restore-btn')).not.toBeDisplayed()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    if (!(await $('#git-changes-host').isDisplayed()))
      await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('.git-changes-restore-btn')).not.toBeDisplayed()
    await saveSettledChangesScreenshot(
      'session-backup-clean-baseline-after-restart.png',
      ['draft.txt', 'new-file.txt'],
      'Refined edit',
    )
  })

  it('keeps the earlier restore point when a manual follow-up turns the next edit into a proposal', async () => {
    writeFileSync(join(root, 'draft.txt'), userDraft)
    const scenario = await installMockScenario({
      title: 'Review a manual follow-up',
      turns: [
        {
          user: 'Repair this draft before review.',
          responses: [
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'draft.txt', content: 'Repair for review\n' } },
              ],
            },
            { text: 'The draft is repaired.' },
          ],
        },
        {
          user: 'Propose the next revision.',
          responses: [
            {
              toolCalls: [
                { name: 'write_file', args: { path: 'draft.txt', content: 'Proposed revision\n' } },
              ],
            },
            { text: 'The revision is ready for approval.' },
          ],
        },
      ],
    })
    await setComposerValue('Repair this draft before review.')
    await submitComposer()
    await scenario.waitForTurns(1)
    await waitForAgentIdle(30_000)
    const refs = git('for-each-ref', '--format=%(refname)', 'refs/copse/backups/')
    writeFileSync(join(root, 'draft.txt'), 'Manual follow-up\n')
    writeFileSync(join(root, 'new-user-note.txt'), 'Keep this new user note\n')
    await setComposerValue('Propose the next revision.')
    await submitComposer()
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await waitForAgentIdle(30_000)
    assert.equal(readFileSync(join(root, 'draft.txt'), 'utf8'), 'Manual follow-up\n')
    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/copse/backups/'), refs)
    if (!(await $('#git-changes-host').isDisplayed()))
      await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('.git-changes-restore-btn')).toBeDisplayed()
    await saveSettledChangesScreenshot(
      'session-backup-proposal-retains-point.png',
      ['draft.txt', 'draft.txt', 'new-file.txt', 'new-user-note.txt'],
      'Proposed revision',
      true,
    )
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    if (!(await $('#git-changes-host').isDisplayed()))
      await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('.git-changes-restore-btn')).toBeDisplayed()
    await $('.git-changes-restore-btn').click()
    await expect($('#confirm-dialog')).toBeDisplayed()
    await $('.confirm-dialog-confirm').click()
    await browser.waitUntil(
      async () => readFileSync(join(root, 'draft.txt'), 'utf8') === userDraft,
      { timeout: 10_000, timeoutMsg: 'a proposal replaced the earlier user restore point' },
    )
    assert.equal(readFileSync(join(root, 'new-user-note.txt'), 'utf8'), 'Keep this new user note\n')
    await expect($('.git-changes-restore-btn')).toBeEnabled()
    await browser.waitUntil(
      async () => (await $('.monaco-diff-editor').getText()).includes(userDraft.trim()),
      { timeout: 10_000, timeoutMsg: 'the diff did not refresh to the restored draft' },
    )
    await saveSettledChangesScreenshot(
      'session-backup-proposal-restored-after-restart.png',
      ['draft.txt', 'new-file.txt', 'new-user-note.txt'],
      userDraft.trim(),
    )
  })
})
