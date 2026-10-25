import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Side chat replies render like the main conversation', () => {
  before(async () => {
    await browser.url('/?scenario=side-chat-rich-markdown')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  it('shows a diagram, highlighted code, table copy and prompt line breaks in the side chat', async () => {
    await $('[data-message-id="sc-assistant-1"] .msg-side-chat-chip').click()
    const body = $('.side-chat-body-host')
    await body.waitForDisplayed({ timeout: 10_000 })
    const reply = body.$('.side-chat-msg.is-assistant .message-text')

    // The same isolated Mermaid frame as the main conversation, rendered once
    // it is in view.
    await reply.$('.mermaid-diagram').scrollIntoView({ block: 'center' })
    await reply.$('.mermaid-frame[data-rendered="true"]').waitForExist({ timeout: 40_000 })
    await expect(reply.$('.mermaid-fallback-title')).not.toExist()
    await expect(reply.$('pre code .hljs-string')).toExist()
    await expect(reply.$('.code-block-copy')).toExist()
    await expect(reply.$('.table-copy')).toExist()
    // Run would execute in the main thread, so a side chat offers copy only.
    await expect(reply.$('.code-block-run')).not.toExist()
    await expect(body.$('.side-chat-msg.is-user br')).toExist()

    await saveElementScreenshot('#body', 'side-chat-rich-markdown.png')
  })
})
