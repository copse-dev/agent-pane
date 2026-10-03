import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('Changes while the committed lookup is pending', function () {
  this.timeout(120_000)
  let repoRoot = ''
  let barrier = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    barrier = mkdtempSync(join(tmpdir(), 'copse-committed-barrier-'))
    writeE2eEnv({ COPSE_E2E_GIT_COMMITTED_BARRIER: barrier })
    resetUserData()
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    await browser.waitUntil(async () => (await $('.workspace-name').getText()) !== 'No folder')
  })

  after(() => {
    if (barrier) writeFileSync(join(barrier, 'release'), '')
    writeE2eEnv({ COPSE_E2E_GIT_COMMITTED_BARRIER: undefined })
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
    if (barrier) rmSync(barrier, { recursive: true, force: true })
  })

  it('shows working-tree rows and their diff before committed work answers', async () => {
    await $('.titlebar-btn[aria-label="Open changes"]').click()
    await browser.waitUntil(() => existsSync(join(barrier, 'started')), {
      timeout: 30_000,
      timeoutMsg: 'expected the real committed IPC handler to reach the barrier',
    })
    await expect($('.git-change-row*=staged.ts')).toBeDisplayed()
    await expect($('.git-change-row*=unstaged.ts')).toBeDisplayed()
    await expect($('.git-change-row*=untracked.ts')).toBeDisplayed()
    await expect($('#git-changes-host')).toHaveText(
      expect.stringContaining('Checking committed changes'),
    )
    const pendingText = await $('#git-changes-host').getText()
    assert.doesNotMatch(pendingText, /Loading changes|committed\.ts/)
    assert.equal(existsSync(join(barrier, 'release')), false)
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await saveElementScreenshot('#git-changes-host', 'git-changes-committed-pending.png')
    writeFileSync(join(barrier, 'release'), '')
    await expect($('.git-change-row*=committed.ts')).toBeDisplayed()
    await browser.waitUntil(
      async () => !(await $('#git-changes-host').getText()).includes('Checking committed changes'),
    )
    await expect($('.git-change-row*=staged.ts')).toHaveElementClass('is-selected')
  })
})
