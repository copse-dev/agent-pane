import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const MAIN = 'Fix flaky mermaid e2e'

// A side chat is hidden from the sidebar and never becomes the active thread, so a
// tool approval it needs surfaces over its parent thread, says which side chat is
// asking, and opens that side chat beside the thread.
describe('A side chat asks for approval over its parent thread', () => {
  before(async () => {
    await browser.url('/?scenario=side-chat-approval')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  it('shows the request over the parent, names the side chat and opens it beside the thread', async () => {
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect($('#approval-dialog .approval-heading')).toHaveText('Run outside sandbox?')
    await expect($('#approval-dialog .approval-origin')).toHaveText(
      'From the side chat “waitForExist vs waitForDisplayed”',
    )
    await expect($('#approval-dialog .approval-body')).toHaveText(
      expect.stringContaining('tests/e2e/mermaid.e2e.ts'),
    )
    // The asking side chat is open beside the thread it branched from.
    await $('.side-chat-body-host').waitForDisplayed({ timeout: 10_000 })
    await expect($('.side-chat-row.is-selected')).toHaveAttribute('data-side-chat-id', 'sc-side-1')
    // No hidden thread is flagged: the side chat has no sidebar row of its own.
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
    await saveElementScreenshot('#body', 'side-chat-approval-over-parent.png')

    await $('#approval-dialog .approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
