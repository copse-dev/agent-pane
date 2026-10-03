import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { openProjectManager } from './helpers/project-manager.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'

describe('project quarantine and orphan recovery', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const now = Date.now()
    const extraOrphanStores = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const suffix = String(index).padStart(2, '0')
        const timestamp = now - index - 1
        return [
          `threads:orphan-store-${suffix}`,
          [
            {
              id: `orphan-thread-${suffix}`,
              title: `Recovered notes ${suffix}`,
              status: 'idle',
              messages: [
                {
                  id: `orphan-message-${suffix}`,
                  role: 'user',
                  content: 'Keep this thread recoverable.',
                  toolCalls: [],
                  createdAt: timestamp,
                },
              ],
              usage: { inputTokens: 0, outputTokens: 0 },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        ]
      }),
    )
    writeSeedConfig({
      projects: [
        { id: 'healthy', path: process.cwd(), name: 'Healthy project' },
        {
          id: 'missing',
          path: '/volumes/archive/moved-project',
          name: 'Moved project',
          missing: true,
        },
      ],
      activeProjectId: 'healthy',
      'threads:healthy': [],
      'threads:orphan-store': [
        {
          id: 'orphan-thread',
          title: 'Recovered planning notes',
          status: 'idle',
          messages: [
            {
              id: 'orphan-message',
              role: 'user',
              content: 'Keep this thread recoverable.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
      ...extraOrphanStores,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('surfaces the missing project and recoverable threads in the default thread view', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const notice = $('.thread-browser .thread-browser-notice[data-project-id="missing"]')
    await notice.waitForDisplayed({ timeout: 15_000 })
    await expect(notice.$('.thread-browser-notice-heading')).toHaveText('Moved project')
    await expect(notice.$('.project-missing-btn')).toHaveText('Relocate…')
    const orphanSection = $('.thread-browser .orphans-section')
    await orphanSection.waitForDisplayed({ timeout: 15_000 })
    await expect(orphanSection.$('.orphan-name')).toHaveText('Recovered planning notes')
    await expect(orphanSection.$('.orphan-recover-btn')).toHaveText('Recover…')
    const titleFits = await browser.execute(() => {
      const title = document.querySelector<HTMLElement>('.thread-browser .orphan-name')
      return title !== null && title.scrollWidth <= title.clientWidth
    })
    assert.equal(titleFits, true, 'the recoverable thread title should not be truncated')
    await saveElementScreenshot('#pane-projects', 'thread-sidebar-recovery.png')
  })

  it('shows preserved missing projects and recoverable orphan threads', async () => {
    await openProjectManager()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const missingRow = await $('.project-row.missing')
    await missingRow.waitForDisplayed({ timeout: 15_000 })
    await expect(missingRow.$('.project-name')).toHaveText('Moved project')
    assert.match((await missingRow.getAttribute('title')) ?? '', /folder missing/i)

    await missingRow.click()
    const notice = await $('.thread-project-manager .project-missing-notice')
    await notice.waitForDisplayed({ timeout: 10_000 })
    await expect(notice.$('.project-missing-text')).toHaveText(
      'This folder could not be opened. Its threads are safe — relocate the project to restore them.',
    )
    await expect(notice.$('.project-missing-btn')).toHaveText('Relocate…')

    const orphanSection = await $('.thread-project-manager .orphans-section')
    await orphanSection.waitForDisplayed({ timeout: 15_000 })
    await expect(orphanSection.$('.orphans-heading')).toHaveText('Recoverable threads')
    await expect(orphanSection.$('.orphan-name')).toHaveText('Recovered planning notes')
    await expect(orphanSection.$('.orphan-meta')).toHaveText('1 thread')
    await expect(orphanSection.$('.orphan-recover-btn')).toHaveText('Recover…')
    await expect(orphanSection.$('.orphan-dismiss-btn')).toHaveText('Dismiss')
    const titleFits = await browser.execute(() => {
      const title = document.querySelector<HTMLElement>('.thread-project-manager .orphan-name')
      return title !== null && title.scrollWidth <= title.clientWidth
    })
    assert.equal(titleFits, true, 'the recoverable thread title should not be truncated')

    await orphanSection.$('.orphan-recover-btn').click()
    const confirm = await $('#confirm-dialog')
    await confirm.waitForDisplayed({ timeout: 10_000 })
    await expect(confirm.$('.confirm-dialog-message')).toHaveText(
      'Recover “Recovered planning notes”?',
    )
    assert.match(
      (await confirm.$('.confirm-dialog-detail').getText()) ?? '',
      /Recovered planning notes/,
    )
    await expect(confirm.$('.confirm-dialog-confirm')).toHaveText('Choose folder…')
    await confirm.$('.confirm-dialog-cancel').click()
    await browser.waitUntil(async () => !(await confirm.isDisplayed()), { timeout: 5_000 })

    await saveElementScreenshot('#pane-projects', 'project-quarantine-recovery.png')
  })

  it('dismisses a recoverable orphan row from the sidebar without jumping to the top', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const orphanSection = await $('.thread-project-manager .orphans-section')
    await orphanSection.waitForDisplayed({ timeout: 15_000 })

    const scrollBefore = await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('.projects-list')
      if (!list) return -1
      list.scrollTop = 80
      return list.scrollTop
    })
    assert.ok(scrollBefore > 0, 'the recoverable threads list should be scrollable')

    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>(
          '.thread-project-manager .orphan-row[data-orphan-id="orphan-store"] .orphan-dismiss-btn',
        )
        ?.click()
    })
    await browser.waitUntil(
      async () =>
        !(await $(
          '.thread-project-manager .orphan-row[data-orphan-id="orphan-store"]',
        ).isExisting()),
      {
        timeout: 10_000,
        timeoutMsg: 'dismissed orphan row should leave the list',
      },
    )
    const scrollAfter = await browser.execute(
      () => document.querySelector<HTMLElement>('.projects-list')?.scrollTop ?? -1,
    )
    assert.equal(scrollAfter, scrollBefore, 'dismissing a row should preserve the scroll position')
    await expect($('.project-row*=Healthy project')).toBeDisplayed()
    await expect($('.project-row.missing')).toBeDisplayed()
    await saveElementScreenshot('.projects-list', 'project-quarantine-recovery-dismissed.png')
  })
})
