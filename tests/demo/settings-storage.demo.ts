import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted Storage project picker', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="storage"]').click()
    await $('.settings-section[data-section="storage"]').waitForDisplayed()
  })

  it('shows the selected project and its durable project path above worktree storage', async () => {
    const storage = $('.settings-section[data-section="storage"]')
    const project = storage.$('#storage-project-select')
    await expect(project).toBeDisplayed()
    assert.equal(await project.getValue(), 'demo-settings-footer-project')
    assert.equal(await project.$$('option').length, 1)
    await expect(storage.$('#storage-project-path')).toHaveText('/demo/copse')
    await expect(storage.$('legend=Worktrees')).toBeDisplayed()
    await expect(storage.$('#sources-worktrees-list')).toHaveText(
      expect.stringContaining('No worktrees'),
    )

    await saveElementScreenshot('#settings-dialog', 'settings-storage-project-picker.png')
  })
})
