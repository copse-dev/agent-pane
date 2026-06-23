import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedQueuedMessageFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('queued message edit and send-now', () => {
  let queuedMessageId = ''

  before(async () => {
    resetUserData()
    const seeded = seedQueuedMessageFixture(process.cwd())
    queuedMessageId = seeded.queuedMessageId
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('exposes Edit and Send now actions on a queued message', async () => {
    const queuedMsg = await $(`.msg-queued[data-message-id="${queuedMessageId}"]`)
    await queuedMsg.waitForExist({ timeout: 15_000 })

    // Badge uses CSS text-transform: uppercase, so the rendered text is upper-cased.
    await expect(queuedMsg.$('.message-queued-badge')).toHaveText('QUEUED')
    await expect(queuedMsg.$('.queued-edit')).toBeDisplayed()
    await expect(queuedMsg.$('.queued-send-now')).toBeDisplayed()
    // Exactly one action row — guards against duplicate decoration on re-render.
    await expect(queuedMsg.$$('.message-queued-actions')).toBeElementsArrayOfSize(1)

    await saveAppScreenshot('queued-message-actions.png')
    await saveElementScreenshot('.conversation-queued', 'queued-message-panel.png')
  })

  it('pauses the queue and shows an inline editor when Edit is clicked', async () => {
    const queuedMsg = await $(`.msg-queued[data-message-id="${queuedMessageId}"]`)
    await queuedMsg.$('.queued-edit').click()

    const editingMsg = await $(`.msg-editing[data-message-id="${queuedMessageId}"]`)
    await editingMsg.waitForExist({ timeout: 5_000 })
    await expect(editingMsg.$('.message-queued-badge')).toHaveText('EDITING')

    const input = await editingMsg.$('.message-edit-input')
    await expect(input).toBeDisplayed()
    await expect(input).toHaveValue('Then add unit tests for the parser.')
    await expect(editingMsg.$('.queued-send')).toBeDisplayed()
    await expect(editingMsg.$('.queued-cancel')).toBeDisplayed()

    await saveAppScreenshot('queued-message-editing.png')
  })

  it('confirms the edit with Send and re-queues with updated text', async () => {
    const editingMsg = await $(`.msg-editing[data-message-id="${queuedMessageId}"]`)
    const input = await editingMsg.$('.message-edit-input')
    await input.setValue('Then add unit tests AND integration tests for the parser.')
    await editingMsg.$('.queued-send').click()

    const queuedMsg = await $(`.msg-queued[data-message-id="${queuedMessageId}"]`)
    await browser.waitUntil(
      async () => (await queuedMsg.$('.message-queued-badge').getText()) === 'QUEUED',
      { timeout: 5_000 },
    )
    await expect(queuedMsg.$('.message-text')).toHaveText(
      'Then add unit tests AND integration tests for the parser.',
    )
    // Still queued (thread is "running"), with actions available again.
    await expect(queuedMsg.$('.queued-edit')).toBeDisplayed()

    await saveAppScreenshot('queued-message-edited.png')
  })
})
