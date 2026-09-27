import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function openChanges(): Promise<void> {
  await browser.waitUntil(
    async () => (await (await $('.workspace-name')).getText()) !== 'No folder',
    { timeout: 60_000, timeoutMsg: 'expected a restored workspace before opening Changes' },
  )
  await $('.prompt-input').waitForExist({ timeout: 60_000 })
  await $('.titlebar-btn[aria-label="Open changes"]').waitForExist({ timeout: 30_000 })
  await $('.titlebar-btn[aria-label="Open changes"]').click()
  await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
  await $('.git-changes-header').waitForExist({ timeout: 30_000 })
}

// Visual eval for the "Review" gesture in the Changes view
// (docs/plans/copse-reviewer.md, P9): the button sits in the Changes header
// beside the bulk actions, only while the `copse.review` plugin is enabled —
// a level-3 contribution that follows the plugin's atomic toggle like the
// plugin-gated pane controls — and is enabled while the thread is idle.
describe('Changes view "Review" gesture', function () {
  this.timeout(120_000)

  let repoRoot = ''

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('shows Review in the Changes header once the review plugin is enabled', async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture({ reviewEnabled: true })
    await browser.reloadSession()
    await openChanges()

    const button = $('.git-changes-header .git-changes-review-btn')
    await button.waitForDisplayed({ timeout: 30_000 })
    await expect(button).toHaveText('Review')
    await expect(button).toBeEnabled()
    const placement = await browser.execute(() => {
      const header = document.querySelector('.git-changes-header')
      const children = [...(header?.children ?? [])].map((node) => node.className)
      return {
        afterTitle:
          children.indexOf('git-changes-review-btn') > children.indexOf('pane-header-title'),
        beforePopout:
          children.indexOf('git-changes-review-btn') <
          children.findIndex((name) => name.includes('pane-popout')),
      }
    })
    expect(placement.afterTitle).toBe(true)
    expect(placement.beforePopout).toBe(true)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-review-button.png'))
  })

  it('hides Review while the review plugin is off', async () => {
    resetUserData()
    cleanupGitChangesFixture(repoRoot)
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await openChanges()

    // The gate resolves asynchronously through `plugins:list`; wait for the
    // header to settle before reading the button's state.
    await $('.git-changes-refresh-btn').waitForDisplayed({ timeout: 30_000 })
    await browser.pause(500)
    const hidden = await browser.execute(
      () => document.querySelector<HTMLElement>('.git-changes-review-btn')?.hidden ?? null,
    )
    expect(hidden).toBe(true)
  })
})
