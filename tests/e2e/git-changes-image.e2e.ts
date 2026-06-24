import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitImageChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function openChangesPanel(): Promise<void> {
  const changesBtn = await $('.titlebar-btn[aria-label="Open changes"]')
  await changesBtn.waitForExist({ timeout: 30_000 })
  // The titlebar button no-ops until the seeded workspace has loaded (it routes
  // to add-project when workspaceRoot isn't set yet), and that load is slower on
  // some runners — so a single click can land before the workspace is ready and
  // never activate the panel. Click until the Changes tab actually goes active
  // (only when it isn't already, so we never toggle an open panel shut).
  await browser.waitUntil(
    async () => {
      const tab = await $('.right-panel-tab[aria-label="Changes"]')
      if (
        (await tab.isExisting()) &&
        ((await tab.getAttribute('class')) ?? '').includes('is-active')
      )
        return true
      await changesBtn.click()
      return false
    },
    { timeout: 30_000, interval: 1000, timeoutMsg: 'Changes tab did not become active' },
  )
  await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
  await browser.waitUntil(async () => (await $$('.git-change-row')).length >= 3, {
    timeout: 30_000,
    timeoutMsg: 'expected at least 3 changed image rows',
  })
}

async function clickChange(path: string): Promise<void> {
  const row = await $$('.git-change-row').find(
    async (r) => (await r.$('.git-change-path').getText()) === path,
  )
  if (!row) throw new Error(`missing git change row for ${path}`)
  await row.click()
}

describe('git changes image preview', () => {
  let repoRoot = ''

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitImageChangesFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('shows before/after image previews for staged and unstaged images', async () => {
    await openChangesPanel()

    const paths = await $$('.git-change-path').map((e) => e.getText())
    await expect(paths).toContain('staged.png')
    await expect(paths).toContain('unstaged.png')
    await expect(paths).toContain('new.png')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-image-list.png'))

    await clickChange('staged.png')
    const stagedPreview = await $('#git-diff-viewer-host .git-image-diff')
    await stagedPreview.waitForDisplayed({ timeout: 30_000 })
    await expect($$('#git-diff-viewer-host .git-image-diff-img')).toBeElementsArrayOfSize({
      gte: 2,
    })
    await expect($('#git-diff-viewer-host .monaco-diff-editor')).not.toBeDisplayed()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-image-staged.png'))

    await clickChange('unstaged.png')
    await $('#git-diff-viewer-host .git-image-diff').waitForDisplayed({ timeout: 30_000 })
    await expect($$('#git-diff-viewer-host .git-image-diff-img')).toBeElementsArrayOfSize({
      gte: 2,
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-image-unstaged.png'))

    await clickChange('new.png')
    await $('#git-diff-viewer-host .git-image-diff').waitForDisplayed({ timeout: 30_000 })
    await expect($$('#git-diff-viewer-host .git-image-diff-img')).toBeElementsArrayOfSize(1)
    await expect($('#git-diff-viewer-host .git-image-diff-label')).toHaveText(
      expect.stringMatching(/^after$/i),
    )
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-image-untracked.png'))
  })
})
