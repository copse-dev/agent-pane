import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('LM Studio prompt processing progress', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-prompt-progress-'))
    // The mock provider drives the LM Studio progress chunk, while a catalogued
    // large-context model keeps this UI eval independent of local model discovery.
    seedEmptyProject(workspaceRoot, 'e2e-prompt-progress', { model: 'claude-sonnet-4-6' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows provider prefill percentage until the first output chunk', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue(
      'Exercise prompt processing. [[mock:prompt_progress 0.47]] [[mock:delay_ms 5000]]',
    )
    await $('.submit-btn').click()

    const activity = $('.agent-activity')
    await activity.waitForDisplayed({ timeout: 10_000 })
    await expect(activity.$('.agent-activity-label')).toHaveText('Processing prompt… 47%')
    await expect(activity).toHaveAttribute('role', 'status')
    await expect(activity).toHaveAttribute('aria-live', 'polite')
    await saveElementScreenshot('#input-bar', 'lm-studio-prompt-progress.png')

    await $('.stop-btn').click()
    await activity.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
