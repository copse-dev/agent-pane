import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitImageChangesFixture,
} from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => (await (await $('.workspace-name')).getText()) !== 'No folder',
    { timeout: 60_000, timeoutMsg: 'expected a restored workspace before opening Changes' },
  )
}

async function openChangesPanel(): Promise<void> {
  await $('.titlebar-btn[aria-label="Open changes"]').waitForExist({ timeout: 30_000 })
  // The titlebar button no-ops until the seeded workspace has loaded (it routes
  // to add-project when workspaceRoot isn't set yet), and that load is slower on
  // some runners — so a single click can land before the workspace is ready and
  // never activate the panel. Click until the Changes tab actually goes active
  // (only when it isn't already, so we never toggle an open panel shut).
  await browser.waitUntil(
    async () => {
      // Opening the panel can rebuild the titlebar. Reacquire the button on
      // every retry so WebDriver never reuses an element from the old frame.
      const changesBtn = await $('.titlebar-btn[aria-label="Open changes"]')
      if (((await changesBtn.getAttribute('class')) ?? '').includes('active')) return true
      await changesBtn.click()
      return false
    },
    { timeout: 30_000, interval: 1000, timeoutMsg: 'Changes button did not become active' },
  )
  await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
  // The event-driven refresh on panel activation can race the seeded git
  // fixture; force a refresh explicitly so the change rows are populated.
  await (await $('.git-changes-refresh-btn')).click()
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

async function proposeImage(path: string, bytes: Buffer): Promise<void> {
  const args = JSON.stringify({ path, content: bytes.toString('latin1') })
  await setComposerValue(`[[mcp:write_file ${args}]]`)
  await $('.submit-btn').click()
  await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Send', {
    timeout: 60_000,
    interval: 500,
    timeoutMsg: 'Agent did not return to idle after proposing the image',
  })
}

describe('git changes image preview', function () {
  this.timeout(90_000)

  let repoRoot = ''

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitImageChangesFixture()
    await browser.reloadSession()
    await waitForWorkspace()
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

  it('shows a proposed image preview with approval actions', async () => {
    const proposedBytes = readFileSync(
      join(process.cwd(), 'tests/e2e/fixtures/git-changes-red.png'),
    )
    const interveningBytes = readFileSync(
      join(process.cwd(), 'tests/e2e/fixtures/git-changes-blue.png'),
    )

    // A new file applies directly. Change it outside Copse, then request the
    // original image again so the stale-overwrite guard stages the replacement.
    await proposeImage('proposed.png', proposedBytes)
    writeFileSync(join(repoRoot, 'proposed.png'), interveningBytes)
    await proposeImage('proposed.png', proposedBytes)

    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 30_000 })
    await $('#git-diff-viewer-host .git-image-diff').waitForDisplayed({ timeout: 30_000 })
    await expect($$('#git-diff-viewer-host .git-image-diff-img')).toBeElementsArrayOfSize(2)
    const labels = await $$('#git-diff-viewer-host .git-image-diff-label').map((e) => e.getText())
    await expect(labels).toEqual(['BEFORE', 'AFTER'])
    await expect($('#git-diff-viewer-host .monaco-diff-editor')).not.toBeDisplayed()
    await expect($('#git-diff-viewer-host .diff-accept-btn')).toBeDisplayed()
    await expect($('#git-diff-viewer-host .diff-reject-btn')).toBeDisplayed()

    const src = await $(
      '#git-diff-viewer-host .git-image-diff-img[alt="proposed.png (after)"]',
    ).getAttribute('src')
    await expect(src).toBe(`data:image/png;base64,${proposedBytes.toString('base64')}`)
    await saveElementScreenshot('#git-diff-viewer-host', 'git-changes-image-proposed.png')

    await $('#git-diff-viewer-host .diff-reject-btn').click()
  })
})
