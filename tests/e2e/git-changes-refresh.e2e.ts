import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

describe('Changes background refresh', function () {
  this.timeout(120_000)
  let repoRoot = ''
  let barrier = ''

  before(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'copse-clean-refresh-'))
    barrier = mkdtempSync(join(tmpdir(), 'copse-refresh-barrier-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
    }
    git('init', '-b', 'main')
    git('config', 'user.name', 'E2E')
    git('config', 'user.email', 'e2e@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'init.defaultBranch', 'main')
    writeFileSync(join(repoRoot, 'example.ts'), 'export const value = 1\n')
    git('add', '.')
    git('commit', '-m', 'baseline')
    writeFileSync(join(barrier, 'release'), '')
    writeE2eEnv({ COPSE_E2E_GIT_COMMITTED_BARRIER: barrier })
    resetUserData()
    writeSeedConfig({
      projects: [{ id: 'refresh-project', path: repoRoot, name: 'Refresh fixture' }],
      activeProjectId: 'refresh-project',
      activeThreadId: 'refresh-thread',
      workspaceRoot: repoRoot,
      'threads:refresh-project': [
        {
          id: 'refresh-thread',
          title: 'Changes refresh',
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
    await $('.titlebar-btn[aria-label="Open changes"]').click()
    await expect($('#git-changes-host .git-changes-empty')).toHaveText('No changes')
  })

  after(() => {
    if (barrier) writeFileSync(join(barrier, 'release'), '')
    writeE2eEnv({ COPSE_E2E_GIT_COMMITTED_BARRIER: undefined })
    resetUserData()
    if (repoRoot) removeE2eTree(repoRoot)
    if (barrier) removeE2eTree(barrier)
  })

  it('keeps the settled empty state while refreshing, then displays actual edits', async () => {
    await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('.git-changes-list')
      const empty = list?.querySelector<HTMLElement>('.git-changes-empty')
      if (!list || !empty) throw new Error('expected settled Changes list')
      empty.dataset['retained'] = 'true'
      list.dataset['mutations'] = '0'
      const observer = new MutationObserver((records) => {
        list.dataset['mutations'] = String(Number(list.dataset['mutations']) + records.length)
      })
      observer.observe(list, { childList: true, subtree: true, characterData: true })
    })
    unlinkSync(join(barrier, 'release'))
    unlinkSync(join(barrier, 'started'))
    await $('.git-changes-refresh-btn').click()
    await browser.waitUntil(() => existsSync(join(barrier, 'started')))
    await expect($('#git-changes-host .git-changes-empty')).toHaveText('No changes')
    await expect($('#git-changes-host .pane-loading')).not.toExist()
    await saveElementScreenshot('#git-changes-host', 'git-changes-refresh-retained.png')
    assert.equal(await $('.git-changes-empty').getAttribute('data-retained'), 'true')
    assert.equal(await $('.git-changes-list').getAttribute('data-mutations'), '0')
    writeFileSync(join(barrier, 'release'), '')
    // A real filesystem change takes the same background refresh path.
    writeFileSync(join(repoRoot, 'example.ts'), 'export const value = 2\n')
    await expect($('.git-change-row*=example.ts')).toBeDisplayed()
  })
})
