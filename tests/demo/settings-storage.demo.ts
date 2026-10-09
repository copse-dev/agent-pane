import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'
import type { WorktreeInventoryEntry } from '../../src/shared/types/worktree.ts'

declare global {
  interface Window {
    worktreeCleanupFixture: { calls: string[]; finish: () => void }
  }
}

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

describe('browser-hosted worktree cleanup cancellation', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await browser.execute(() => {
      const entries: WorktreeInventoryEntry[] = ['/demo/first', '/demo/second'].map((path) => ({
        path,
        branch: path.endsWith('first') ? 'feature/first' : 'feature/second',
        baseBranch: 'main',
        head: null,
        detached: false,
        locked: null,
        prunable: null,
        managed: false,
        usage: null,
        createdAt: null,
        lastUsedAt: null,
        changedCount: 1,
        merged: false,
      }))
      window.worktreeCleanupFixture = {
        calls: [],
        finish: (): void => {
          throw new Error('cleanup not started')
        },
      }
      window.api.worktrees.list = (): ReturnType<typeof window.api.worktrees.list> =>
        Promise.resolve(entries)
      window.api.worktrees.size = (
        _projectId,
        path,
      ): ReturnType<typeof window.api.worktrees.size> =>
        Promise.resolve({ path, bytes: 4096, fileCount: 2, truncated: false })
      window.api.worktrees.cleanupPackages = (
        _projectId,
        path,
        remove,
      ): ReturnType<typeof window.api.worktrees.cleanupPackages> => {
        if (!remove) throw new Error('bulk cleanup should not preview')
        window.worktreeCleanupFixture.calls.push(path)
        return new Promise((resolve) => {
          window.worktreeCleanupFixture.finish = (): void => {
            resolve({
              status: 'cleaned',
              path,
              changedCount: 0,
              directories: [{ path: 'node_modules', bytes: 1024, truncated: false }],
              bytes: 1024,
              truncated: false,
            })
          }
        })
      }
    })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="storage"]').click()
    await expect($$('.sources-row[data-worktree-path]')).toBeElementsArrayOfSize(2)
    await $('#sources-worktrees-select-all').click()
    await $('#sources-worktrees-cleanup').click()
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await expect($('#confirm-dialog .confirm-dialog-confirm')).toHaveText('Cleaning 1 of 2…')
  })

  for (const method of ['button', 'escape']) {
    it(`closes immediately by ${method} and leaves the queued worktree untouched`, async () => {
      const confirm = $('#confirm-dialog')
      await expect(confirm.$('.confirm-dialog-cancel')).toBeClickable()
      await expect(confirm.$('.confirm-dialog-confirm')).toBeDisabled()
      if (method === 'button') {
        await saveElementScreenshot('#confirm-dialog', 'settings-worktree-cleanup-cancellable.png')
        await confirm.$('.confirm-dialog-cancel').click()
      } else await browser.keys('Escape')
      await expect(confirm).not.toBeDisplayed()
      await expect($('#sources-worktrees-status')).toHaveText(
        'Stopping cleanup after the current worktree finishes…',
      )
      await expect($('#sources-worktrees-cleanup')).toBeDisabled()
      await browser.execute(() => {
        window.worktreeCleanupFixture.finish()
      })
      await expect($('#sources-worktrees-status')).toHaveText(
        expect.stringContaining('Cleanup stopped.'),
      )
      assert.deepEqual(await browser.execute(() => window.worktreeCleanupFixture.calls), [
        '/demo/first',
      ])
      await expect($('#sources-worktrees-selected-count')).toHaveText('1 selected')
      await expect($('#sources-worktrees-cleanup')).toBeClickable()
      if (method === 'button') {
        await saveElementScreenshot(
          '.sources-worktrees-fieldset',
          'settings-worktree-cleanup-stopped.png',
        )
      }
    })
  }
})
