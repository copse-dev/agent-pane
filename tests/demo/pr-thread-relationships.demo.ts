import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Related threads sit behind a toggle beside the producer; open it once.
async function showRelated(): Promise<void> {
  const toggle = $('.pr-thread-toggle')
  if ((await toggle.isExisting()) && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
  }
}

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
    await expect($('.pr-thread-link[data-thread-id="pr-producer"]')).toHaveText('Implement widget')
    await expect($('.pr-list-relationship')).toHaveText('Produced')
    await expect($('.pr-thread-toggle')).toHaveText('2 related')
    await expect($('.pr-thread-link[data-thread-id="pr-reviewer"]')).not.toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-producing-and-related-threads.png')

    await showRelated()
    await expect($('.pr-thread-link[data-thread-id="pr-reviewer"]')).toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-producing-and-related-threads-expanded.png')

    await $('.pr-thread-link[data-thread-id="pr-reviewer"]').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Review widget')
    await expect($$('.pr-list-row[data-pr-section="linked"]')).toBeElementsArrayOfSize(2)
    await saveElementScreenshot('#pane-files', 'thread-multiple-related-prs.png')
    await $('.pr-list-row[data-pr-section="linked"]').click()
    await showRelated()
    await $('.pr-thread-link[data-thread-id="pr-mentioned"]').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Release planning')
  })

  it('a mention-only PR cannot claim a producing thread', async () => {
    await showRelated()
    await $('.pr-thread-link[data-thread-id="pr-reviewer"]').click()
    const rows = await $$('.pr-list-row[data-pr-section="linked"]')
    const second = rows[1]
    if (!second) throw new Error('Missing second related PR')
    await second.click()
    await expect($('.pr-viewer-title')).toHaveText('Follow up on widget review')
    await expect($('.pr-thread-group[data-relationship-group="produced"]')).not.toExist()
    await expect($$('.pr-thread-link[data-relationship="produced"]')).toBeElementsArrayOfSize(0)
    await saveElementScreenshot('#pane-files', 'pr-mention-without-producer.png')
  })

  // Relationships live in the Overview tab's own content (not the fixed
  // header) precisely so that hiding them on other tabs cannot move the tab
  // bar: regression coverage for that header-reflow bug.
  it('keeps the header in place when relationships hide on other tabs', async () => {
    const rows = await $$('.pr-list-row[data-pr-section="linked"]')
    const first = rows[0]
    if (!first) throw new Error('Missing "Add widget support" row')
    await first.click()
    await expect($('.pr-viewer-title')).toHaveText('Add widget support')
    await $('.pr-thread-relationships').waitForDisplayed({ timeout: 20_000 })
    const meta = $('.pr-viewer-meta')
    const sections = $('.pr-detail-sections')
    const metaRect = async (): Promise<unknown> => ({
      ...(await meta.getLocation()),
      ...(await meta.getSize()),
    })
    const sectionsRect = async (): Promise<unknown> => ({
      ...(await sections.getLocation()),
      ...(await sections.getSize()),
    })
    const overviewMetaBox = await metaRect()
    const overviewSectionsBox = await sectionsRect()
    for (const section of ['comments', 'checks', 'files']) {
      await $(`[data-section="${section}"]`).click()
      await expect($('.pr-thread-relationships')).not.toBeDisplayed()
      expect(await metaRect()).toEqual(overviewMetaBox)
      expect(await sectionsRect()).toEqual(overviewSectionsBox)
    }
    await $('[data-section="checks"]').click()
    await saveElementScreenshot('#pane-files', 'pr-relationships-hidden-on-checks-tab.png')
    await $('[data-section="overview"]').click()
    await expect($('.pr-thread-relationships')).toBeDisplayed()
    expect(await metaRect()).toEqual(overviewMetaBox)
  })
})
