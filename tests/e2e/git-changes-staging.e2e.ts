import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { parkPointer, saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

// Staging from the Changes pane: a line selection in the diff stages only the
// change it touches, and the file-level button moves the whole file back.

const lines = (edits: Record<number, string>): string =>
  Array.from(
    { length: 30 },
    (_, i) => edits[i + 1] ?? `export const line${String(i + 1)} = ${String(i + 1)}`,
  )
    .join('\n')
    .concat('\n')

describe('Changes pane staging', function () {
  this.timeout(120_000)
  let repoRoot = ''
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' })

  before(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'copse-stage-hunks-'))
    git('init', '-b', 'main')
    git('config', 'user.name', 'E2E')
    git('config', 'user.email', 'e2e@example.com')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(repoRoot, 'pane.ts'), lines({}))
    git('add', '.')
    git('commit', '-m', 'baseline')
    writeFileSync(
      join(repoRoot, 'pane.ts'),
      lines({
        3: 'export const line3 = "EDITED_TOP"',
        25: 'export const line25 = "STAGED_ALONE"',
      }),
    )
    resetUserData()
    writeSeedConfig({
      projects: [{ id: 'stage-project', path: repoRoot, name: 'Staging fixture' }],
      activeProjectId: 'stage-project',
      activeThreadId: 'stage-thread',
      workspaceRoot: repoRoot,
      'threads:stage-project': [
        {
          id: 'stage-thread',
          title: 'Stage part of a file',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    await $('.titlebar-btn[aria-label="Open review"]').click()
    await $('#git-changes-host').$('.git-change-row*=pane.ts').waitForDisplayed({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (repoRoot) removeE2eTree(repoRoot)
  })

  it('stages the change a line selection touches, then unstages the whole file', async () => {
    const line25 = $('#git-diff-viewer-host .modified-in-monaco-diff-editor').$(
      '.view-line*=STAGED_ALONE',
    )
    await line25.waitForDisplayed({ timeout: 30_000 })
    await expect($('.git-stage-lines-btn')).toHaveText('Stage selection')
    await line25.click()
    await $('.git-stage-lines-btn').click()

    await expect($('.git-stage-status')).toHaveText('Staged the selected changes.')
    await browser.waitUntil(
      async () =>
        (await $$('#git-changes-host .git-changes-section-title').map((t) => t.getText()))
          .join('|')
          .toLowerCase() === 'staged (1)|unstaged (1)',
      { timeout: 15_000, timeoutMsg: 'expected pane.ts in both Staged and Unstaged' },
    )
    const staged = git('diff', '--cached', '-U0')
    assert.match(staged, /STAGED_ALONE/)
    assert.doesNotMatch(staged, /EDITED_TOP/)
    assert.match(git('diff', '-U0'), /EDITED_TOP/)
    await parkPointer()
    await saveElementScreenshot('#pane-files', 'git-changes-stage-selection.png')

    const stagedSection = await $$('#git-changes-host .git-changes-section').find(async (section) =>
      (await section.$('.git-changes-section-title').getText()).toLowerCase().startsWith('staged'),
    )
    assert.ok(stagedSection)
    await stagedSection.$('.git-change-row').click()
    await expect($('.git-stage-file-btn')).toHaveText('Unstage file')
    await $('.git-stage-file-btn').click()
    await expect($('.git-stage-status')).toHaveText('Unstaged pane.ts.')
    await browser.waitUntil(async () => git('diff', '--cached', '--name-only') === '', {
      timeout: 15_000,
      timeoutMsg: 'expected nothing staged',
    })
    // The file followed to Unstaged, which now holds both edits again.
    await expect($('#git-changes-host .git-change-row.is-selected')).toHaveText(
      expect.stringContaining('pane.ts'),
    )
    await expect($('.git-stage-file-btn')).toHaveText('Stage file')
  })
})
