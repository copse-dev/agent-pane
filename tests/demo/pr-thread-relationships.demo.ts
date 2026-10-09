import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('PR producing and related threads', () => {
  before(async () => {
    await browser.url('/?scenario=pr-relations')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const pane = $('#pane-files')
    if (!(await pane.isDisplayed())) await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open pull requests"]').click()
    await $('.pr-thread-relationships').waitForDisplayed({ timeout: 20_000 })
  })

  it('shows the producer and all references, and opens each thread independently', async () => {
    await expect($('.pr-viewer-title')).toHaveText('Add widget support')
    await expect($$('.pr-thread-link[data-relationship="produced"]')).toBeElementsArrayOfSize(1)
    await expect($$('.pr-thread-link[data-relationship="related"]')).toBeElementsArrayOfSize(2)
    await expect($('.pr-thread-link[data-thread-id="pr-producer"]')).toHaveText(
      'Implement widget\nCreated PR',
    )
    await expect($('.pr-list-relationship')).toHaveText('Produced')
    await saveElementScreenshot('#pane-files', 'pr-producing-and-related-threads.png')

    await $('.pr-thread-link[data-thread-id="pr-reviewer"]').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Review widget')
    await expect($$('.pr-list-row[data-pr-section="linked"]')).toBeElementsArrayOfSize(2)
    await saveElementScreenshot('#pane-files', 'thread-multiple-related-prs.png')
    await $('.pr-list-row[data-pr-section="linked"]').click()
    await $('.pr-thread-link[data-thread-id="pr-mentioned"]').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Release planning')
  })

  it('a mention-only PR cannot claim a producing thread', async () => {
    await $('.pr-thread-link[data-thread-id="pr-reviewer"]').click()
    const rows = await $$('.pr-list-row[data-pr-section="linked"]').getElements()
    const second = rows[1]
    if (!second) throw new Error('Missing second related PR')
    await second.click()
    await expect($('.pr-viewer-title')).toHaveText('Follow up on widget review')
    await expect($('.pr-thread-group[data-relationship-group="produced"]')).toHaveText(
      'Producing threads\nNo recorded producing thread.',
    )
    await expect($$('.pr-thread-link[data-relationship="produced"]')).toBeElementsArrayOfSize(0)
    await saveElementScreenshot('#pane-files', 'pr-mention-without-producer.png')
  })
})
