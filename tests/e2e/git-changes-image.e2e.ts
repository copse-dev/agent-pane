import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedEmptyProject,
  seedGitImageChangesFixture,
} from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

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
  let proposedRoot = ''

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
    if (proposedRoot) cleanupGitChangesFixture(proposedRoot)
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

    const stagedAfter = await $(
      '#git-diff-viewer-host .git-image-diff-img[alt="staged.png (after)"]',
    )
    const stagedAfterSrc = await stagedAfter.getAttribute('src')
    await stagedAfter.click()
    const expandDialog = $('dialog.attachment-preview-dialog[open]')
    await expandDialog.waitForExist({ timeout: 5_000 })
    const expandedImg = await $('.image-expand-image')
    await expect(expandedImg).toExist()
    await expect(expandedImg).toHaveAttribute('src', stagedAfterSrc ?? '')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-image-expand.png'))
    await $('.attachment-preview-close').click()
    await browser.waitUntil(
      async () => !(await $('dialog.attachment-preview-dialog[open]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'expand modal did not close' },
    )

    const beforeImage = await $(
      '#git-diff-viewer-host .git-image-diff-img[alt="staged.png (before)"]',
    )
    const afterImage = await $(
      '#git-diff-viewer-host .git-image-diff-img[alt="staged.png (after)"]',
    )
    await expect(beforeImage).toHaveAttribute('role', 'button')
    await expect(beforeImage).toHaveAttribute('tabindex', '0')
    await expect(afterImage).toHaveAttribute('role', 'button')
    const beforeSrc = await beforeImage.getAttribute('src')
    const afterSrc = await afterImage.getAttribute('src')

    // Keep a real turn active while dismissing the modal. The app-level Escape
    // shortcut arms agent cancellation, so the preview must isolate the key
    // while preserving the dialog's native close behavior.
    await setComposerValue('Keep working while I inspect this image. [[mock:delay_ms 15000]]')
    await $('.submit-btn').click()
    const stopButton = await $('.stop-btn')
    await stopButton.waitForDisplayed({ timeout: 15_000 })

    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const target = document.querySelector<HTMLElement>(
            '#git-diff-viewer-host .git-image-diff-img[alt="staged.png (before)"]',
          )
          if (!target) return false
          target.focus()
          return document.activeElement === target
        }),
      { timeout: 5_000, timeoutMsg: 'expected the current before image to receive focus' },
    )
    await browser.keys('Enter')
    const preview = await $('dialog.attachment-preview-dialog[open]')
    await preview.waitForDisplayed({ timeout: 5_000 })
    await expect(preview.$('.attachment-preview-title')).toHaveText('staged.png (before)')
    await expect(preview.$('.image-expand-image')).toHaveAttribute('src', beforeSrc ?? '')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-image-expanded.png'))

    await browser.keys('Escape')
    await preview.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.activeElement?.getAttribute('alt') === 'staged.png (before)',
        ),
      { timeout: 5_000, timeoutMsg: 'expected Escape to restore focus to the before image' },
    )
    await expect(stopButton).toBeDisplayed()
    await expect(stopButton).not.toHaveElementClass('stop-pending')
    await stopButton.click()
    await waitForAgentIdle(15_000)

    await $('#git-diff-viewer-host .git-image-diff-img[alt="staged.png (after)"]').click()
    await preview.waitForDisplayed({ timeout: 5_000 })
    await expect(preview.$('.attachment-preview-title')).toHaveText('staged.png (after)')
    await expect(preview.$('.image-expand-image')).toHaveAttribute('src', afterSrc ?? '')
    await preview.$('.attachment-preview-close').click()
    await preview.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await browser.waitUntil(
      () =>
        browser.execute(() => document.activeElement?.getAttribute('alt') === 'staged.png (after)'),
      { timeout: 5_000, timeoutMsg: 'expected Close to restore focus to the after image' },
    )

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

    // A Git-backed edit can apply once Copse has made a recovery snapshot.
    // Use an ordinary non-Git project to reach the supported approval path,
    // independently of whether backup creation succeeds on this platform.
    proposedRoot = mkdtempSync(join(tmpdir(), 'copse-proposed-image-'))
    writeFileSync(join(proposedRoot, 'proposed.png'), interveningBytes)
    resetUserData()
    seedEmptyProject(proposedRoot, 'e2e-proposed-image-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await waitForWorkspace()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
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
