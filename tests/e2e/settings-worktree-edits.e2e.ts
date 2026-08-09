import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('worktree edit approval setting', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-worktree-edits')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the isolated-worktree toggle under File edits, on by default', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    await $('.settings-nav-btn[data-section="permissions"]').click()
    const permissions = $('.settings-section[data-section="permissions"]')
    await expect(permissions).toBeDisplayed()

    const toggle = await permissions.$('input[name="worktreeAutoApproveEdits"]')
    await expect(toggle).toBeExisting()
    assert.equal(await toggle.isSelected(), true)

    // It belongs to the File edits fieldset, beside the two ACP edit toggles —
    // not to Shell commands or Web and terminals.
    const legend = await browser.execute(
      () =>
        document
          .querySelector<HTMLElement>('input[name="worktreeAutoApproveEdits"]')
          ?.closest('fieldset')
          ?.querySelector('legend')?.textContent ?? '',
    )
    assert.equal(legend.trim(), 'File edits')

    await browser.execute(() => {
      const input = document.querySelector<HTMLElement>('input[name="worktreeAutoApproveEdits"]')
      input?.closest('fieldset')?.scrollIntoView()
    })
    await browser.pause(100)
    await saveElementScreenshot('#settings-dialog', 'settings-worktree-edits.png')
  })
})
