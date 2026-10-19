import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, seedE2eViewport } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'archive-review-project'
const THREAD = 'archive-review-thread'
const RESTORE_THREAD = 'archive-restore-thread'

describe('finished thread review and settings', function () {
  this.timeout(120_000)
  before(async () => {
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT, name: 'Earlier work', path: process.cwd() }],
      activeProjectId: PROJECT,
      expandedProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Review the earlier task',
          status: 'idle',
          messages: [
            {
              id: 'request',
              role: 'user',
              content: 'Explore the options for the next release.',
              toolCalls: [],
              createdAt: 1,
            },
            {
              id: 'reply',
              role: 'assistant',
              content: 'The options are recorded. Choose the next steps when you return.',
              toolCalls: [],
              createdAt: 2,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 2,
          prRefs: [],
        },
        {
          id: RESTORE_THREAD,
          title: 'Preserve this conversation',
          status: 'idle',
          messages: [
            {
              id: 'restore-request',
              role: 'user',
              content: 'Remember these release notes.',
              toolCalls: [],
              createdAt: 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 2,
          prRefs: [],
        },
      ],
    })
    seedE2eViewport({ width: 1280, height: 800 })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
  })

  it('asks on returning to uncertain work and Undo restores the conversation', async () => {
    const review = $('.thread-archive-review')
    await review.waitForDisplayed({ timeout: 30_000 })
    await expect(review).toHaveText(expect.stringContaining('Finished with this thread?'))
    await expect($(`.chat-row[data-thread-id="${THREAD}"]`)).toBeDisplayed()
    await saveAppScreenshot('thread-auto-archive-review.png')
    await review.$('button=Archive').click()
    const undo = $('.toast-action=Undo')
    await undo.waitForDisplayed()
    await expect($(`.chat-row[data-thread-id="${THREAD}"]`)).not.toBeExisting()
    await saveAppScreenshot('thread-archive-undo.png')
    await undo.click()
    await review.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await expect($(`.chat-row[data-thread-id="${THREAD}"]`)).toBeDisplayed()
    await expect($('.conversation-scroll')).toHaveText(
      expect.stringContaining('Explore the options for the next release.'),
    )
  })

  it('discovers an archive after restart and restores its transcript', async () => {
    await $(`.chat-row[data-thread-id="${RESTORE_THREAD}"]`).click()
    const review = $('.thread-archive-review')
    await review.waitForDisplayed({ timeout: 30_000 })
    await review.$('button=Archive').click()
    await $(`.chat-row[data-thread-id="${RESTORE_THREAD}"]`).waitForExist({ reverse: true })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.projects-filter-btn:not(.projects-sort-btn)').click()
    await $('[role="menuitemcheckbox"]=Archived').click()
    const row = $(`.archived-thread-row[data-thread-id="${RESTORE_THREAD}"]`)
    await row.waitForDisplayed()
    await expect(row).toHaveText(expect.stringContaining('Preserve this conversation'))
    await saveAppScreenshot('thread-archive-discovery.png')
    await row.$('button=Restore').click()
    await expect($(`.chat-row[data-thread-id="${RESTORE_THREAD}"]`)).toBeDisplayed()
    await expect($('.conversation-scroll')).toHaveText(
      expect.stringContaining('Remember these release notes.'),
    )
    await expect(review).not.toBeDisplayed()
    await saveAppScreenshot('thread-archive-restored.png')
  })

  it('defaults to three days and persists both a longer delay and disabling', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="storage"]').click()
    const days = $('input[name="autoArchiveAfterDays"]')
    await expect(days).toHaveValue('3')
    await days.setValue('7')
    await saveElementScreenshot('#settings-dialog', 'settings-auto-archive.png')
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="storage"]').click()
    await expect(days).toHaveValue('7')
    await days.setValue('0')
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="storage"]').click()
    await expect(days).toHaveValue('0')
  })
})
