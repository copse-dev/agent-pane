import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadPrStatusFixture } from './helpers/seed-config.ts'

async function openContext(): Promise<void> {
  const pane = $('#pane-files')
  if (!(await pane.isDisplayed())) {
    await $('[aria-label="Toggle right panel"]').click()
    await pane.waitForDisplayed({ timeout: 10_000 })
  }
  if (!(await $('.thread-context').isDisplayed()))
    await $('[aria-label="Open thread context"]').click()
  await $('.thread-context').waitForDisplayed({ timeout: 10_000 })
}

describe('thread GitHub PR status in Context', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    seedThreadPrStatusFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows linked PR lifecycle and checks in Context, leaving thread rows clear', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-pr-status')).not.toExist()
    await openContext()

    const open = $('[data-link-group="pr"] .thread-context-pr-status.is-open')
    await open.waitForExist({ timeout: 15_000 })
    await expect(open.$('svg[data-icon="git-pull-request"]')).toExist()
    await expect(open).toHaveAttribute('aria-label', expect.stringMatching(/#42.*open/i))
    await expect($('[data-link-group="pr"] .thread-context-chip')).toHaveText('Open')
    await saveElementScreenshot('#pane-files', 'thread-pr-context-open.png')

    await $('.chat-row[data-thread-id="e2e-pr-merged-thread"]').click()
    const merged = $('[data-link-group="pr"] .thread-context-pr-status.is-merged')
    await merged.waitForExist({ timeout: 15_000 })
    await expect(merged.$('svg[data-icon="git-merge"]')).toExist()
    await expect($('[data-link-group="pr"] .thread-context-chip')).toHaveText('Merged')
    await expect($('.chat-row.selected .chat-pr-status')).not.toExist()

    await $('.chat-row[data-thread-id="e2e-pr-failing-thread"]').click()
    const failing = $('[data-link-group="pr"] .thread-context-pr-status.is-open.has-ci-failure')
    await failing.waitForExist({ timeout: 15_000 })
    await expect(failing).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/checks are failing/i),
    )

    await $('.chat-row[data-thread-id="e2e-pr-conflict-thread"]').click()
    const conflict = $('[data-link-group="pr"] .thread-context-pr-status.is-open.has-conflicts')
    await conflict.waitForExist({ timeout: 15_000 })
    await expect(conflict).toHaveAttribute('aria-label', expect.stringMatching(/merge conflicts/i))
    await expect(conflict).not.toHaveElementClass('has-ci-failure')
    await expect(conflict.$('svg path:nth-child(2)')).toHaveAttribute('d', 'M3 3l6 6m0-6L3 9')
    await saveElementScreenshot('#pane-files', 'thread-pr-context-conflict.png')
  })
})
