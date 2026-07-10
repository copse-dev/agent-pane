import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { collectErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-staged-diff-project'
const DIRTY_TREE_SENTINEL = join(process.cwd(), 'tests/e2e/.staged-diff-dirty')

async function waitForAgentIdle(timeoutMs = 60_000): Promise<void> {
  await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Send', {
    timeout: timeoutMs,
    interval: 500,
    timeoutMsg: 'Agent did not return to idle (submit button Send)',
  })
}

async function runWriteFileDirective(path: string, content: string): Promise<void> {
  const args = JSON.stringify({ path, content })
  await setComposerValue(`[[mcp:write_file ${args}]]`)
  await $('.submit-btn').click()
  await waitForAgentIdle()
}

describe('staged diff approval UI', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    writeFileSync(DIRTY_TREE_SENTINEL, 'force staged-diff approval path\n')
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    rmSync(DIRTY_TREE_SENTINEL, { force: true })
    resetUserData()
  })

  it('stages diffs in the Changes panel with single- and multi-file selection', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await runWriteFileDirective('src/e2e-staged-a.ts', 'export const a = 1\n')

    await browser.waitUntil(
      async () =>
        await $('.tool-card[data-status="done"], .tool-card[data-status="running"]').isExisting(),
      { timeout: 30_000, timeoutMsg: 'expected write_file tool card' },
    )

    await expect($('.titlebar-btn[aria-label="Open changes"]')).toHaveElementClass('active')
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 30_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })

    const acceptBtn = await $('#git-diff-viewer-host .diff-accept-btn')
    const rejectBtn = await $('#git-diff-viewer-host .diff-reject-btn')
    await acceptBtn.waitForDisplayed({ timeout: 5_000 })
    await browser.waitUntil(async () => (await acceptBtn.getText()) === 'Accept', {
      timeout: 5_000,
    })
    await expect(rejectBtn).toHaveText('Reject')
    await expect($('.git-changes-bulk-actions')).not.toBeDisplayed()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'staged-diff-single.png'))

    await runWriteFileDirective('src/e2e-staged-b.ts', 'export const b = 2\n')

    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'expected two proposed diff rows',
    })

    await expect($('.git-changes-bulk-actions')).toBeDisplayed()
    await expect($('button*=Accept all')).toBeDisplayed()
    await expect($('button*=Reject all')).toBeDisplayed()

    const paths = await $$('.git-change-row-proposed .git-change-path').map((el) => el.getText())
    await expect(paths).toContain('src/e2e-staged-a.ts')
    await expect(paths).toContain('src/e2e-staged-b.ts')

    const rows = await $$('.git-change-row-proposed')
    const second = await rows.find(async (row) =>
      (await row.$('.git-change-path').getText()).includes('e2e-staged-b.ts'),
    )
    if (!second) throw new Error('missing e2e-staged-b.ts proposed row')
    await second.click()
    await expect(second).toHaveElementClass('is-selected')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'staged-diff-multi.png'))
  })

  it('accepting a CSS staged diff clears the view without error toasts', async function () {
    this.timeout(120_000)

    const rejectAllBtn = await $('button*=Reject all')
    if (await rejectAllBtn.isDisplayed()) {
      await rejectAllBtn.click()
      await browser.waitUntil(
        async () => !(await $('.git-changes-section-proposed').isDisplayed()),
        {
          timeout: 15_000,
          timeoutMsg: 'expected proposed section to close after reject all',
        },
      )
    }

    await runWriteFileDirective(
      'src/e2e-staged-layout.css',
      ['.projects-settings-btn {', '  color: var(--text-muted);', '}', ''].join('\n'),
    )

    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 15_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 15_000 })

    const acceptBtn = await $('#git-diff-viewer-host .diff-accept-btn')
    await acceptBtn.waitForDisplayed({ timeout: 5_000 })
    await acceptBtn.click()

    await browser.waitUntil(async () => !(await $('.git-changes-section-proposed').isDisplayed()), {
      timeout: 15_000,
      timeoutMsg: 'expected proposed section to close after accept',
    })

    await browser.pause(3_000)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'staged-diff-css-accept-no-error.png'))
    await expect(await collectErrorToasts()).toEqual([])
  })
})
