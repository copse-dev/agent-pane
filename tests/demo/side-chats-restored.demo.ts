import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// After an app restart a side chat arrives as metadata only; its transcript is read
// from disk when the Side chat panel selects it. Without that read the panel showed
// the empty-chat prompt for a conversation that had two messages.
describe('Side chats after an app restart', () => {
  before(async () => {
    await browser.url('/?scenario=side-chats-restored')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  it('reads the side chat transcript when its chip opens the panel', async () => {
    await $('[data-message-id="sc-assistant-1"] .msg-side-chat-chip').click()
    await $('.side-chat-body-host').waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(async () => (await $$('.side-chat-msg')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'the restored side chat never showed its transcript',
    })
    await expect($('.side-chat-msg.is-assistant code')).toHaveText('waitForExist')
    await expect($$('.side-chat-suggestion')).toBeElementsArrayOfSize(0)
    await expect($('[data-side-chat-loading]')).not.toExist()
    await expect($('.side-chat-input')).toBeEnabled()
    await saveElementScreenshot('#body', 'side-chat-restored-after-restart.png')
  })
})
